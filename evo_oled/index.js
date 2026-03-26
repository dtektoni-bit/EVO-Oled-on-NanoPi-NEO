const os = require("os");
const date = require('date-and-time');
const oled = require('./oled.js');
const fonts = require('./fonts.js');
const fs = require("fs");
const http = require("http");
const {volumio_listener} = require("./volumiolistener.js");
const Gpio = require('/volumio/node_modules/onoff').Gpio;

// Format seconds to "M:SS"
function fmtTime(sec){
	if(sec == null || isNaN(sec) || sec < 0) return "--:--";
	sec = Math.floor(sec);
	return Math.floor(sec / 60) + ":" + String(sec % 60).padStart(2, "0");
}

// ==========================================================================+
// |  DAC TYPE - change this to match your hardware                          |
// |  'AK4490'  - 5 filters (SLOW + SD + SSLOW pins)                        |
// |  'PCM1794' - 2 filters (SLOW pin only)                                 |
const DAC_TYPE = 'PCM1794';
// +==========================================================================+

// -- GPIO pin numbers (Linux sysfs) -------------------------------------------
const PIN_BUTTON = 2;    // PA2    - button input
const PIN_SLOW   = 3;    // PA3    - SLOW filter bit (both DACs)
const PIN_SD     = 68;   // PC4    - SD filter bit   (AK4490 only)
const PIN_SSLOW  = 363;  // PL11 - SSLOW filter bit (AK4490 only)
const PIN_INPUT  = 203;  // GPIOG11 - input selector (0=Network, 1=SPDIF)

// -- Filter definitions -------------------------------------------------------
const FILTERS_AK4490 = [
  { name: 'Sh.Lin',  sslow: 0, sd: 0, slow: 0 },  // Sharp roll-off
  { name: 'Sl.Lin',  sslow: 0, sd: 0, slow: 1 },  // Slow roll-off
  { name: 'SD.Sh',   sslow: 0, sd: 1, slow: 0 },  // Short delay Sharp (default)
  { name: 'SD.Sl',   sslow: 0, sd: 1, slow: 1 },  // Short delay Slow
  { name: 'S.Slow',  sslow: 1, sd: 0, slow: 0 },  // Super Slow
];

const FILTERS_PCM1794 = [
  { name: 'Sharp', slow: 0 },  // Sharp roll-off (default)
  { name: 'Slow',  slow: 1 },  // Slow roll-off
];

const FILTERS = DAC_TYPE === 'PCM1794' ? FILTERS_PCM1794 : FILTERS_AK4490;
const DEFAULT_FILTER_INDEX = DAC_TYPE === 'PCM1794' ? 0 : 2;

// -- Button timing ------------------------------------------------------------
const LONG_PRESS_MS = 1000;
const DEBOUNCE_MS   = 50;


function ap_oled(){
  
  // Default params that can be overriden with loadConfig (later in runtime) : 
  this.width =  256;
	this.height = 64;
  this.dcPin = 27;
  this.rstPin = 24;
  this.contrast = 254;
  this.main_rate = 32;
  this.base_refresh_track = 20;
  
  this.time_before_screensaver = 60000;
  this.time_before_deepsleep = 120000;
  this.time_before_clock =  6000;
  
  this.logo_duration =  2000;
  
  
  // Cache of streamer state
  this.data = {
    title : null,
    artist : null,
    album : null,
    volume : null,
    samplerate : null,
    bitdepth : null,
    bitrate : null,
    seek : null,
    duration : null,
    status : null,
  };
  
  
  // Renderer inner state
	this.page = null;
  this.ip = null;
  
	this.raw_seek_value = 0;
	this.footertext = "---";
  this.text_to_display = "";
  
  this.scroller_x = 0;
	this.update_interval = null;
  
	this.refresh_action = null;

  // GPIO state
  this.filterIndex  = DEFAULT_FILTER_INDEX;
  this.inputSpdif   = false; // false = Network, true = SPDIF

  // GPIO objects (initialized in initGpio)
  this._btnGpio    = null;
  this._slowGpio   = null;
  this._sdGpio     = null;
  this._sslowGpio  = null;
  this._inputGpio  = null;
  this._pressTime          = null;
  this._debounceTimer      = null;
  this._longPressTimer     = null;
  this._longPressTriggered = false;
  
}

// -- GPIO init ----------------------------------------------------------------
ap_oled.prototype.initGpio = function(){
  try {
    this._btnGpio   = new Gpio(String(PIN_BUTTON), 'in', 'both');
    this._slowGpio  = new Gpio(String(PIN_SLOW),   'out');
    if (DAC_TYPE === 'AK4490') {
      this._sdGpio    = new Gpio(String(PIN_SD),    'out');
      this._sslowGpio = new Gpio(String(PIN_SSLOW), 'out');
    }
    this._inputGpio = new Gpio(String(PIN_INPUT),  'out');
  } catch(e) {
    console.error('[gpio] Failed to init GPIO:', e.message);
    return;
  }

  // Apply default state
  this.applyFilter(DEFAULT_FILTER_INDEX);
  this.applyInput(false);

  // Button watch
  this._btnGpio.watch((err, value) => {
    if (err) { console.error('[gpio] Button error:', err); return; }

    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }

    this._debounceTimer = setTimeout(() => {
      if (value === 1) {
        // Button pressed - start long press timer
        this._longPressTriggered = false;
        this._pressTime = Date.now();
        this._longPressTimer = setTimeout(() => {
          // 1 second reached - fire immediately, no need to wait for release
          this._longPressTriggered = true;
          console.log('[gpio] Long press -> toggle input');
          this.toggleInput();
        }, LONG_PRESS_MS);
      } else {
        // Button released
        if (this._longPressTimer) {
          clearTimeout(this._longPressTimer);
          this._longPressTimer = null;
        }
        if (this._pressTime === null) return;
        this._pressTime = null;

        if (!this._longPressTriggered) {
          // Released before 1 second -> short press
          console.log('[gpio] Short press -> next filter');
          this.nextFilter();
        }
        this._longPressTriggered = false;
      }
    }, DEBOUNCE_MS);
  });

  console.log('[gpio] Initialized. Filter:', FILTERS[this.filterIndex].name,
    '| Input:', this.inputSpdif ? 'SPDIF' : 'Network');
}

ap_oled.prototype.applyFilter = function(index){
  const f = FILTERS[index];
  if (DAC_TYPE === 'AK4490') {
    this._sslowGpio.writeSync(f.sslow);
    this._sdGpio.writeSync(f.sd);
  }
  this._slowGpio.writeSync(f.slow);
  this.filterIndex = index;
  console.log('[gpio] Filter ->', f.name);
}

ap_oled.prototype.nextFilter = function(){
  this.applyFilter((this.filterIndex + 1) % FILTERS.length);
}

ap_oled.prototype.applyInput = function(isSpdif){
  this._inputGpio.writeSync(isSpdif ? 1 : 0);
  this.inputSpdif = isSpdif;
  console.log('[gpio] Input ->', isSpdif ? 'SPDIF' : 'Network');

  // Switch display mode
  if (isSpdif) {
    this.spdif_mode();
  } else {
    if (this.page === 'spdif') {
      this.playback_mode();
    }
  }
}

ap_oled.prototype.toggleInput = function(){
  this.applyInput(!this.inputSpdif);
}

ap_oled.prototype.getFilterLabel = function(){
  return 'DF:' + FILTERS[this.filterIndex].name;
}

ap_oled.prototype.getInputLabel = function(){
  return this.inputSpdif ? 'SPDIF' : 'NETWORK';
}

// -- Startup animation --------------------------------------------------------
ap_oled.prototype.startup_animation = async function(){
  const W = this.width, H = this.height;
  const drv = this.driver;

  // ── Logo geometry (from DXF, rotated 180°) ─────────────────────────────
  const DCX = -179.9424, DCY = -60.4093, R = 10.0;
  const scale = (Math.min(W, H) / 2 - 2) / R;
  const cx = W / 2, cy = H / 2;

  function lx(x) { return cx - (x - DCX) * scale; }
  function ly(y) { return cy + (y - DCY) * scale; }

  function drawLine(x0, y0, x1, y1) {
    x0=Math.round(x0); y0=Math.round(y0); x1=Math.round(x1); y1=Math.round(y1);
    let dx=Math.abs(x1-x0), sx=x0<x1?1:-1, dy=-Math.abs(y1-y0), sy=y0<y1?1:-1, err=dx+dy;
    while(true) {
      drv.drawPixel(x0, y0, 12);
      if(x0===x1 && y0===y1) break;
      const e2=2*err;
      if(e2>=dy){err+=dy; x0+=sx;}
      if(e2<=dx){err+=dx; y0+=sy;}
    }
  }

  function drawLogoFrame(bright) {
    const g = Math.round(bright * 12);
    const steps = Math.max(200, R * scale * 10);
    // Outer circle
    for(let i=0; i<steps; i++) {
      const a = (i/steps) * Math.PI * 2;
      drv.drawPixel(Math.round(cx + Math.cos(a)*R*scale), Math.round(cy + Math.sin(a)*R*scale), g);
    }
    // Diamond
    const DT=[lx(DCX),ly(DCY-R)], DR=[lx(DCX+R),ly(DCY)], DB=[lx(DCX),ly(DCY+R)], DL=[lx(DCX-R),ly(DCY)];
    drawLine(DT[0],DT[1], DR[0],DR[1]);
    drawLine(DR[0],DR[1], DB[0],DB[1]);
    drawLine(DB[0],DB[1], DL[0],DL[1]);
    drawLine(DL[0],DL[1], DT[0],DT[1]);
    // Arcs via dense line segments (bezier)
    function cubicPt(p0,p1,p2,p3,t){
      const mt=1-t;
      return [mt*mt*mt*p0[0]+3*mt*mt*t*p1[0]+3*mt*t*t*p2[0]+t*t*t*p3[0],
              mt*mt*mt*p0[1]+3*mt*mt*t*p1[1]+3*mt*t*t*p2[1]+t*t*t*p3[1]];
    }
    function drawArc(pts) {
      for(let seg=0; seg<3; seg++) {
        const p0=pts[seg*4], p1=pts[seg*4+1], p2=pts[seg*4+2], p3=pts[seg*4+3];
        for(let i=0; i<=80; i++) {
          const pt = cubicPt(p0,p1,p2,p3,i/80);
          drv.drawPixel(Math.round(lx(pt[0])), Math.round(ly(pt[1])), g);
        }
      }
    }
    // Right arc (DXF coords)
    drawArc([
      [-179.9424,-65.4093],[-176.8549,-65.4093],[-174.0019,-64.4564],[-172.4582,-62.9093],
      [-172.4582,-62.9093],[-170.9144,-61.3623],[-170.9144,-59.4564],[-172.4582,-57.9093],
      [-172.4582,-57.9093],[-174.0019,-56.3623],[-176.8549,-55.4093],[-179.9424,-55.4093]
    ]);
    // Left arc
    drawArc([
      [-179.9424,-65.4092],[-183.0299,-65.4092],[-185.8829,-64.4563],[-187.4266,-62.9092],
      [-187.4266,-62.9092],[-188.9704,-61.3622],[-188.9704,-59.4563],[-187.4266,-57.9092],
      [-187.4266,-57.9092],[-185.8829,-56.3622],[-183.0299,-55.4092],[-179.9424,-55.4092]
    ]);
    // Vertical line: arc junction top → circle bottom
    drawLine(Math.round(lx(DCX)), Math.round(ly(-65.4093)),
             Math.round(lx(DCX)), Math.round(ly(DCY+R)));
  }

  // ── 5×7 bitmap font helpers ──────────────────────────────────────────────
  const FONT5x7 = {
    'D':['11110','10001','10001','10001','10001','10001','11110'],
    'P':['11110','10001','10001','11110','10000','10000','10000'],
    'l':['01100','00100','00100','00100','00100','00100','01110'],
    'a':['00000','01110','00001','01111','10001','10011','01101'],
    'y':['00000','10001','10001','10001','01111','00001','01110'],
    'e':['00000','01110','10001','11111','10000','10001','01110'],
    'r':['00000','10110','11001','10000','10000','10000','10000'],
    ' ':['00000','00000','00000','00000','00000','00000','00000'],
    'N':['10001','11001','10101','10011','10001','10001','10001'],
    't':['00100','00100','01110','00100','00100','00100','00011'],
    'w':['00000','10001','10001','10101','10101','11011','10001'],
    'o':['00000','01110','10001','10001','10001','10001','01110'],
    'k':['10000','10010','10100','11000','10100','10010','10001'],
    'A':['01110','10001','10001','11111','10001','10001','10001'],
    'u':['00000','10001','10001','10001','10001','10011','01101'],
    'i':['00100','00000','01100','00100','00100','00100','01110'],
    'B':['11110','10001','10001','11110','10001','10001','11110'],
    'C':['01110','10001','10000','10000','10000','10001','01110'],
    'c':['00000','01110','10001','10000','10000','10001','01110'],
    'h':['10000','10000','10110','11001','10001','10001','10001'],
    'd':['00001','00001','01101','10011','10001','10011','01101'],
  };
  function drawStr(str, sx, sy, g, scale2=1) {
    let x = sx;
    for(const ch of str) {
      const bmp = FONT5x7[ch] || FONT5x7[' '];
      for(let row=0; row<7; row++)
        for(let col=0; col<5; col++)
          if(bmp[row][col]==='1')
            for(let dy=0;dy<scale2;dy++) for(let dx=0;dx<scale2;dx++)
              drv.drawPixel(x+col*scale2+dx, sy+row*scale2+dy, g);
      x += (5+1)*scale2;
    }
  }
  function strW(str, scale2=1) { return str.length * 6 * scale2; }

  function sleepMs(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ── Timing ────────────────────────────────────────────────────────────────
  const FPS = 30, TICK = Math.round(1000/FPS);
  const PH_IN=45, PH_HOLD=55, PH_EXP=50, PH_FLOAT=30, PH_GATHER=80, PH_LOGO=90;
  const T1=PH_IN, T2=T1+PH_HOLD, T3=T2+PH_EXP, T4=T3+PH_FLOAT, T5=T4+PH_GATHER, T6=T5+PH_LOGO;

  // ── Build logo pixel list ─────────────────────────────────────────────────
  // Draw logo to a temp buffer and collect pixel positions
  const logoPixels = [];
  {
    const buf = Buffer.alloc(W*H).fill(0);
    const tmpDrv = {
      drawPixel: (x,y) => {
        x=x|0; y=y|0;
        if(x>=0&&x<W&&y>=0&&y<H) buf[y*W+x]=1;
      }
    };
    const saved = drv.drawPixel.bind(drv);
    drv.drawPixel = tmpDrv.drawPixel;
    drawLogoFrame(1);
    drv.drawPixel = saved;
    for(let y=0;y<H;y++) for(let x=0;x<W;x++)
      if(buf[y*W+x]) logoPixels.push([x,y]);
  }

  // ── Particles ─────────────────────────────────────────────────────────────
  const parts = logoPixels.map(([tx,ty]) => {
    const ang = Math.random()*Math.PI*2, spd = 0.5+Math.random()*3.5;
    return { x:W/2+(Math.random()-0.5)*8, y:H/2+(Math.random()-0.5)*4,
             vx:Math.cos(ang)*spd, vy:Math.sin(ang)*spd, tx, ty };
  });

  function eio(t){return t<0.5?2*t*t:-1+(4-2*t)*t;}

  function drawText(alpha) {
    const g14=Math.round(14*alpha), g9=Math.round(9*alpha), g5=Math.round(5*alpha);
    if(!g14) return;
    // "DDPlayer" — 5×7 scale 2
    const main='DDPlayer', mw=strW(main,2);
    drawStr(main, Math.round((W-mw)/2), 14, g14, 2);
    // "Network Audio Player" — 5×7 scale 1
    const sub='Network Audio Player', sw=strW(sub,1);
    drawStr(sub, Math.round((W-sw)/2), 32, g9, 1);
    // "By Claude" — top right, tiny
    if(g5) {
      const bc='By Claude', bw=strW(bc,1);
      drawStr(bc, W-bw-2, 2, g5, 1);
    }
  }

  // ── Main animation loop ───────────────────────────────────────────────────
  for(let tick=0; tick<=T6; tick++) {
    const t0 = Date.now();
    drv.buffer.fill(0x00);

    if(tick<=T1) {
      drawText(tick/PH_IN);
    }
    else if(tick<=T2) {
      drawText(1);
    }
    else if(tick<=T3) {
      const p=(tick-T2)/PH_EXP;
      drawText(Math.max(0, 1-p*2.5));
      for(const pt of parts) {
        pt.x+=pt.vx; pt.y+=pt.vy; pt.vy+=0.05; pt.vx*=0.97;
        drv.drawPixel(Math.round(pt.x), Math.round(pt.y), Math.round(10*(1-p*0.2)));
      }
    }
    else if(tick<=T4) {
      for(const pt of parts) {
        pt.vx*=0.90; pt.vy*=0.90; pt.x+=pt.vx; pt.y+=pt.vy;
        drv.drawPixel(Math.round(pt.x), Math.round(pt.y), 8);
      }
    }
    else if(tick<=T5) {
      const p=eio((tick-T4)/PH_GATHER);
      for(const pt of parts) {
        const gx=pt.x+(pt.tx-pt.x)*p, gy=pt.y+(pt.ty-pt.y)*p;
        drv.drawPixel(Math.round(gx), Math.round(gy), Math.round(8+p*5));
      }
    }
    else {
      const pulse = 0.82+0.18*Math.sin((tick-T5)*0.15);
      drawLogoFrame(pulse);
    }

    await drv.update();
    const elapsed = Date.now()-t0;
    if(elapsed < TICK) await sleepMs(TICK-elapsed);
  }
};

// -- SPI Driver ---------------------------------------------------------------
ap_oled.prototype.initSpiDriver = async function(){
  this.driver = new oled(this.width, this.height, this.dcPin, this.rstPin, this.contrast );
  await this.driver.begin();
}

ap_oled.prototype.loadConfig = async function(){
	
  let config = {};
  try{
    let raw_config = await fs.promises.readFile("config.json");
    let conf = JSON.parse( raw_config.toString() );
		
		Object.entries(conf).forEach( ([key,data])=>{
			
			switch(key){
				
				case "sleep_after": 
					this.time_before_screensaver = data.value * 1000;
				break;
				
				case "deep_sleep_after": 
					this.time_before_deepsleep = data.value * 1000;
				break;
				
				case "contrast": 
					if(data.value > 0 && data.value < 255) this.contrast = data.value;
					else console.warn("Contrast defined in config file is invalid, ignoring...")
				break;
				
			}
			
		} )
		
  }
  catch(err){
    console.log("Cannot read config file. Using default settings instead.", err) 
    config = null;
  }

	
}

ap_oled.prototype.begin = async function(){
 
  await this.initSpiDriver();
  this.initGpio();
  
  await this.driver.load_hex_font("unifont.hex");
  await this.startup_animation();

  // make sure display gets turned off when our process is terminated
	const exitcatch = async ()=> {
    try{
      clearInterval(this.update_interval);
      await this.driver.turnOffDisplay();
      // unexport GPIO
      if(this._btnGpio)   this._btnGpio.unexport();
      if(this._slowGpio)  this._slowGpio.unexport();
      if(DAC_TYPE === 'AK4490'){
        if(this._sdGpio)    this._sdGpio.unexport();
        if(this._sslowGpio) this._sslowGpio.unexport();
      }
      if(this._inputGpio) this._inputGpio.unexport();
    }
    catch(err){ }
		process.exit();
	}

	process.on('SIGINT',  async e=> await exitcatch() );
	process.on('SIGTERM', async e=> await exitcatch() );


  //  map what happens in Volumio => what is shown on display
  
  const streamer = new volumio_listener();

  streamer.on("volumeChange", (data)=>{ 
    this.data.volume = data;
  });

  streamer.on("stateChange", (data)=>{ 
    this.data.status = data;
  } );

  streamer.on("trackChange", (data)=>{
    this.text_to_display = data ;
    this.driver.CacheGlyphsData( data + "0123456789:-");
    this.text_width = this.driver.getStringWidthUnifont(data + " - ");
    this.scroller_x = 0;
    this.reset_refreshTrack();
    this.footertext = "";
    updatefooter();
  });

  streamer.on("seekChange", (data)=>{
    this.data.ratiobar     = ( data.ratiobar * (this.width - 6) );
    this.data.seek_string  = ( data.seek_string );
    this.data.seek_sec     = Math.floor( (streamer.data.seek || 0) / 1000 );
    this.data.duration_sec = streamer.data.duration || 0;
  });

  streamer.on("repeatChange", (data)=>{
    if(streamer.data.repeat || streamer.data.repeatSingle ) this.data.repeat = true;
    else this.data.repeat = null;
  });

  streamer.on("encodingChange", (data)=>{
    this.data.trackType = data ? data.toUpperCase() : data;
  });

  // service label: short display names for known services
  const updateServiceLabel = () => {
    const svc = (streamer.data.service || "").toLowerCase();
    const map = {
      "mpd":             null,          // use trackType (FLAC/MP3/...)
      "spop":            "SPOTIFY",
      "spotify":         "SPOTIFY",
      "tidalconnect":    "TIDAL",
      "tidal":           "TIDAL",
      "upnp_browser":    null,          // use trackType
      "upnp":            null,
      "airplay":         "AIRPLAY",
      "bluetooth":       "BT",
      "webradio":        "RADIO",
    };
    if (svc in map)  this.data.serviceLabel = map[svc];
    else if (svc)    this.data.serviceLabel = svc.toUpperCase().substring(0, 8);
    else             this.data.serviceLabel = null;
  };
  streamer.on("stateChange", updateServiceLabel);
  streamer.on("trackChange", () => { updateServiceLabel(); });

  const updatefooter = () =>{
    let parts = [];
    if ( streamer.data.samplerate ) parts.push( streamer.data.samplerate.toString().replace(/\s/gi,"") );
    if ( streamer.data.bitdepth   ) parts.push( streamer.data.bitdepth.toString().replace(/\s/gi,"") );
    this.footertext = parts.length > 0 ? parts.join(" : ") : "";
  }

  streamer.on("sampleRateChange", (data)=>{updatefooter()});
  streamer.on("sampleDepthChange", (data)=>{updatefooter()});
  streamer.on("bitRateChange", (data)=>{updatefooter()});

  streamer.watchIdleState(this.time_before_clock);
  streamer.on("iddleStart", (data)=>{this.handle_sleep(false)});
  streamer.on("iddleStop", (data)=>{this.handle_sleep(true)});

  this.playback_mode();
  this.listen_to("ip",1000);


  
}

ap_oled.prototype.startHTTPServer = function(){
  
 const server = async (req,res)=> {
   
    let cmd = req.url.split("\/")[1];
    value = cmd.split("=");
    cmd = value[0];
    value = value[1];
    
    switch(cmd){
      case 'exit':
        res.end("1");
        process.exit(0);
        break;
      case 'contrast':
        value = parseInt(value);
        if( value < 255 && value > 0 ){
          if(value === this.contrast) return res.end("1");;
          let temp = this.refresh_action;
					
					res.end("1");
          this.contrast = value;
					
          this.refresh_action = async () =>{
            this.refresh_action = ()=>{};
            await this.driver.setContrast(value);
            this.refresh_action = temp;
            this.refresh_action();
          };
        }
        else{ res.end("0") }
        break;
      case 'sleep_after':
        this.time_before_screensaver = value;
        res.end("1");
        break;
      case 'deep_sleep_after':
        this.time_before_deepsleep = value;
        res.end("1");
        break;
      default:
        res.end("0");
        break;
    }
  }
    
  this.httpServer = http.createServer(server).listen(4153);
  
}

ap_oled.prototype.reset_refreshTrack = function(){
  this.refresh_track = this.base_refresh_track;
}

ap_oled.prototype.listen_to = function(api,frequency){
	frequency= frequency || 1000;
	let api_caller = null;
  if( api === "ip" ){
    api_caller = setInterval( ()=>{this.get_ip()}, frequency );
    return api_caller;
  }
}

ap_oled.prototype.snake_screensaver = function(){
if (this.page === "snake_screensaver") return;
	clearInterval(this.update_interval);
	this.page = "snake_screensaver";
	
	let box_pos = [0,0];
	let count = 0;
	let flip = false;
	let tail = [];
	let tail_max = 25;
	let t_tail_length = 1;
	let random_pickups = [];
	let screen_saver_animation_reset =()=>{
		tail = [];
		count = 0;
		t_tail_length = 10;
		random_pickups = [];
		let nb = 7;
		while(nb--){
			let _x =  Math.floor(Math.random() * (this.width ));
			let _y =  Math.floor(Math.random() * (this.height/3))*3;
			random_pickups.push([_x,_y]);
		}	
	}
	screen_saver_animation_reset();
	this.refresh_action = ()=>{
		this.driver.buffer.fill(0x00);
		let x;
		if( count % this.width == 0) {flip = !flip}
		if(flip) x = count % this.width +1
		else x = this.width - count % this.width
		let y = ~~( count / this.width ) *3
		tail.push([x,y]);
		if(tail.length > t_tail_length ) tail.shift();
		for(let i of tail){
			this.driver.fillRect(i[0],i[1]-1,2,3,1);
		}
		for(let r of random_pickups){
			if(  ( ( flip && x >= r[0] ) || ( !flip && x <= r[0] ) ) && y >= r[1] ){ 
				t_tail_length +=5;
				random_pickups.splice(random_pickups.indexOf(r),1)
			}
			this.driver.fillRect(r[0],r[1],1,1,1);
		}
		count++;
		this.driver.update(true);
		if(y > this.height ) screen_saver_animation_reset();
	}
	this.update_interval = setInterval( ()=>{this.refresh_action()}, 40);
}

ap_oled.prototype.deep_sleep = function(){
if (this.page === "deep_sleep") return;
	this.status_off = true;
	clearInterval(this.update_interval);
	this.page = "deep_sleep";
	this.driver.turnOffDisplay();
}

// -- Clock mode (Stop, Network input) -----------------------------------------
ap_oled.prototype.clock_mode = function(){
if (this.page === "clock") return;
	clearInterval(this.update_interval);
	this.page = "clock";
	
	this.refresh_action = ()=>{
		this.driver.buffer.fill(0x00);
		let fdate = date.format(new Date(),'YYYY/MM/DD'),
		ftime = date.format(new Date(),'HH:mm:ss');

    // input label centered top  (NETWORK)
    const inputLabel = this.getInputLabel();
    const inputLabelWidth = inputLabel.length * 6;
    this.driver.setCursor( Math.floor((this.width - inputLabelWidth) / 2), 0);
    this.driver.writeString(fonts.monospace, 1, inputLabel, 3);

    // date - top right
		this.driver.setCursor(160, 0);
		this.driver.writeString(fonts.monospace, 1, fdate, 3);
		
    // time - large center
		this.driver.setCursor(50, 15);
		this.driver.writeString(fonts.monospace, 3, ftime, 6);
		this.driver.drawLine(1, 41, 255, 41, 5, false);
		
    // IP - bottom left
		this.driver.setCursor(0, 47);
		this.driver.writeString(fonts.monospace, 1, (this.ip ? this.ip : "No network..."), 4);

    // filter label - bottom right  (DF:SD.Sh)
    const filterLabel = this.getFilterLabel();
    const filterLabelWidth = filterLabel.length * 6;
    this.driver.setCursor(this.width - filterLabelWidth, 49);
    this.driver.writeString(fonts.monospace, 1, filterLabel, 5);

		this.driver.update(true);
	}
	this.refresh_action();
	this.update_interval = setInterval( ()=>{this.refresh_action()}, 1000);
}

// -- SPDIF mode (Stop, SPDIF input) -------------------------------------------
ap_oled.prototype.spdif_mode = function(){
if (this.page === "spdif") return;
	clearInterval(this.update_interval);
	this.page = "spdif";
	
	this.refresh_action = ()=>{
		this.driver.buffer.fill(0x00);
		let fdate = date.format(new Date(),'YYYY/MM/DD'),
		ftime = date.format(new Date(),'HH:mm:ss');

    // input label centered top (SPDIF)
    const inputLabel = this.getInputLabel();
    const inputLabelWidth = inputLabel.length * 6;
    this.driver.setCursor( Math.floor((this.width - inputLabelWidth) / 2), 0);
    this.driver.writeString(fonts.monospace, 1, inputLabel, 3);

    // date - top right
		this.driver.setCursor(160, 0);
		this.driver.writeString(fonts.monospace, 1, fdate, 3);

    // time - large center
		this.driver.setCursor(50, 15);
		this.driver.writeString(fonts.monospace, 3, ftime, 6);
		this.driver.drawLine(1, 41, 255, 41, 5, false);

    // IP - bottom left
		this.driver.setCursor(0, 42);
		this.driver.writeString(fonts.monospace, 1, (this.ip ? this.ip : "No network..."), 4);

    // filter label - bottom right
    const filterLabel = this.getFilterLabel();
    const filterLabelWidth = filterLabel.length * 6;
    this.driver.setCursor(this.width - filterLabelWidth, 47);
    this.driver.writeString(fonts.monospace, 1, filterLabel, 5);

		this.driver.update(true);
	}
	this.refresh_action();
	this.update_interval = setInterval( ()=>{this.refresh_action()}, 1000);
}

// -- Playback mode (Network input) --------------------------------------------
ap_oled.prototype.playback_mode = function(){
    
	if (this.page === "playback") return;
	
	clearInterval(this.update_interval);

 	this.scroller_x = 0;
	this.page = "playback";
	
	this.reset_refreshTrack
	this.refresh_action =()=>{
		
    if(this.plotting){ return };
		
    this.plotting = true;
		this.driver.buffer.fill(0x00);
		
		if(this.data){

      // input label centered top (NETWORK)
      const inputLabel = this.getInputLabel();
      const inputLabelWidth = inputLabel.length * 6;
      this.driver.setCursor( Math.floor((this.width - inputLabelWidth) / 2), 0);
      this.driver.writeString(fonts.monospace, 1, inputLabel, 3);

			// repeat
			if( this.data.repeat ){
				this.driver.setCursor(232,0);
                this.driver.writeString(fonts.icons , 1 , "4" ,5); 
            }
			
			// service label: non-mpd=service name, mpd=track type (FLAC/MP3/...)
			const serviceLabel = this.data.serviceLabel != null
				? this.data.serviceLabel
				: (this.data.trackType || '');
			if(serviceLabel){
				this.driver.setCursor(35,1);
				this.driver.writeString(fonts.monospace , 1 , serviceLabel ,4);
			}
			// play pause stop icon
			if(this.data.status){
				let status_symbol = "";
				switch(this.data.status){
					case ("play"):
						status_symbol = "1";
						break;
					case ("pause"):
						status_symbol = "2"
						break;		
					case ("stop"):
						status_symbol = "3"
						break;
				}    
				this.driver.setCursor(246,0);
				this.driver.writeString(fonts.icons ,1, status_symbol ,6);
			}

			// track title
			if(this.text_to_display?.length){ 
				if( this.text_width <= this.width ){
					this.driver.setCursor( 0, 17 );
					this.driver.writeStringUnifont(this.text_to_display,7 );  
				}
				else{
					let text_to_display = this.text_to_display;
					text_to_display = text_to_display + " - " + text_to_display + " - ";
					if(this.scroller_x + (this.text_width) < 0 ){
						this.scroller_x = 0;
					}
					this.driver.cursor_x = this.scroller_x;
					this.driver.cursor_y = 14
					this.driver.writeStringUnifont(text_to_display,7 );
				}
			}

			// seek bar + bottom info zone
			if(this.data.seek_string){
				let border_right = this.width - 5;
				let Y_seekbar = 35;
				let Ymax_seekbar = 38;
				this.driver.drawLine(3, Y_seekbar, border_right, Y_seekbar, 3);
				this.driver.drawLine(border_right, Y_seekbar, border_right, Ymax_seekbar, 3);
				this.driver.drawLine(3, Ymax_seekbar, border_right, Ymax_seekbar, 3);
				this.driver.drawLine(3, Ymax_seekbar, 3, Y_seekbar, 3);
				this.driver.fillRect(3, Y_seekbar, this.data.ratiobar, 4, 4);

				// elapsed time - bottom left (unifont 16px, Y=43)
				const elapsed = fmtTime(this.data.seek_sec);
				this.driver.setCursor(0, 40);
				this.driver.writeStringUnifont(elapsed, 7);

				// countdown - bottom right (unifont 16px, right-aligned, Y=43)
				const remaining = this.data.duration_sec
					? "-" + fmtTime(this.data.duration_sec - this.data.seek_sec)
					: "--:--";
				const remainW = this.driver.getStringWidthUnifont(remaining);
				this.driver.setCursor(this.width - remainW, 40);
				this.driver.writeStringUnifont(remaining, 7);

					// line 1: samplerate : bitdepth (Y=42)
					if(this.footertext){
						const ftW = this.footertext.length * 6;
						this.driver.setCursor( Math.floor((this.width - ftW) / 2), 43);
						this.driver.writeString(fonts.monospace, 1, this.footertext, 4);
					}
					// line 2: DF:filter (Y=54)
					const dfLabel = this.getFilterLabel();
					const dfW = dfLabel.length * 6;
					this.driver.setCursor( Math.floor((this.width - dfW) / 2), 55);
					this.driver.writeString(fonts.monospace, 1, dfLabel, 4);
			}
		}
		
		this.driver.update();
		this.plotting = false;
        if(this.refresh_track) return this.refresh_track--;
		this.scroller_x--;
	}

	this.update_interval = setInterval( ()=>{ this.refresh_action() }, this.main_rate);
	this.refresh_action();
}

ap_oled.prototype.get_ip = function(){
	try{
		let ips = os.networkInterfaces(), ip = "No network.";
		for(a in ips){
			if( ips[a][0]["address"] !== "127.0.0.1" ){
				ip = ips[a][0]["address"];
				break;
			}
		}
		this.ip = ip;
	}
	catch(e){this.ip = null;}
}

ap_oled.prototype.handle_sleep = function(exit_sleep){
	
	if( !exit_sleep ){
		
		if(!this.iddle_timeout){
			let _deepsleep_ = ()=>{this.deep_sleep();}
			let _screensaver_ = ()=>{
				this.snake_screensaver();
				this.iddle_timeout = setTimeout(_deepsleep_,this.time_before_deepsleep);
			}
      // Go to clock or spdif mode depending on input
      if (this.inputSpdif) {
        this.spdif_mode();
      } else {
        this.clock_mode();
      }
			this.iddle_timeout = setTimeout(_screensaver_,this.time_before_screensaver);
		}
	}
	else{
		if(this.status_off){
			this.status_off = null;
			this.driver.turnOnDisplay();
		}
		
		if(this.page !== "spdif" ){
			this.playback_mode();
		}

		if(this.iddle_timeout){
			clearTimeout(this.iddle_timeout);
			this.iddle_timeout = null;
		}
	}
}
	

;(async ()=>{
 
 const rendererSSD1322 = new ap_oled();
 await rendererSSD1322.loadConfig();
 await rendererSSD1322.begin();
 rendererSSD1322.startHTTPServer();
 
 
})();
