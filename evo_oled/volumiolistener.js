const io = require('/volumio/node_modules/socket.io-client' );
const EventEmitter = require('events').EventEmitter;
const inherits = require('util').inherits;
const cp = require('child_process');

function volumio_listener(host,refreshrate_ms){
  this.host = host || 'http://localhost:3000';
  this.refreshrate_ms = refreshrate_ms || 1000;
  this.ready = false;
  this.waiting = false;
  this.state = "stop";
  this.formatedMainString = "";
  this.data = {};
	this.watchingIdle = false;
	this.firstRequestConsumed = false;
	this.listen();
	this.iddle = false;
	this._iddleTimeout = null;
	this.iddletime = 900;
	this._spotifyKeepAlive = null;
	this._spotifySeekStart = null;   // реальное значение seek от Volumio (мс)
	this._spotifySeekTimestamp = null; // момент когда получили это значение
}

inherits(volumio_listener, EventEmitter);
exports.volumio_listener = volumio_listener;


/*
	Comparer data vs this.data et executer processChange sur chaque clé contenant une nouvelle valeur.
*/
volumio_listener.prototype.compareData = function(data){
	let changes = [];
	for(d in data){
		let previous_data = this.data[d];
		if(this.data[d] === data[d]  ) continue;
		this.data[d] = data[d];
		changes.push([d , this.data[d]]);
	}
	for(change of changes){
		this.processChanges(...change);
	}
}

// résoudre chaque changement d'état
volumio_listener.prototype.processChanges = function(key,data){ 
	
	if( ["title", "artist", "album"].includes(key) ){
		this.formatMainString();								
		this.emit( "trackChange", this.formatedMainString );	
		if(this.state === "play") this.resetIdleTimeout();
	}
	else if(key === "status"){
		this.state = data;
		this.resetIdleTimeout();
		this.emit( "stateChange", data );
		if(data === "play"){
			// При возобновлении — обновить timestamp чтобы считать от текущего места
			if(this._spotifySeekStart !== null && this._spotifySeekTimestamp !== null){
				// Пересчитать накопленный seek на момент паузы
				let elapsed = Date.now() - this._spotifySeekTimestamp;
				this._spotifySeekStart = this._spotifySeekStart + elapsed;
				this._spotifySeekTimestamp = Date.now();
			}
			this._startSpotifyKeepAlive();
		}
		else{
			// При паузе — зафиксировать текущий расчётный seek
			if(this._spotifySeekStart !== null && this._spotifySeekTimestamp !== null){
				let elapsed = Date.now() - this._spotifySeekTimestamp;
				this._spotifySeekStart = this._spotifySeekStart + elapsed;
				this._spotifySeekTimestamp = Date.now();
			}
			this._stopSpotifyKeepAlive();
		}
	}
	else if( ["duration", "seek"].includes(key)){
		if(key === "seek"){
			// Игнорировать обнуление seek при паузе/стопе (Volumio шлёт seek=0 при паузе)
			if(data === 0 && this.state !== "play"){
				return;
			}
			this._spotifySeekStart = data;
			this._spotifySeekTimestamp = Date.now();
		}
		this.resetIdleTimeout();
		this.seekFormat();
		this.emit( "seekChange", this.formatedSeek );
	}
	else if(key === "bitrate"){
		this.emit( "bitRateChange", data );
		this.emit( "line2", "Bit Rate : " + data );
	}
	else if(key === "volume"){
		this.resetIdleTimeout();
		this.emit( "volumeChange", data );
	}
	else if(key === "samplerate"){
		this.emit( "sampleRateChange", data );
		this.emit( "line0", "Sample Rate : " + data );
	}
	else if(key === "bitdepth"){
		this.emit( "sampleDepthChange", data );
		this.emit( "line1", "Sample Depth : " + data );
	}
	else if(key === "albumart"){

		if(data === "/albumart"){
			let waitAndEmit, delayedEmit, cancelDelayedEmit;
			delayedEmit = ()=>{this.emit( "coverChange",this.host+data );}
			waitAndEmit = setTimeout(delayedEmit, 5000);
			cancelDelayedEmit = ()=>{clearTimeout(waitAndEmit);}
			this.once("coverChange", cancelDelayedEmit);
			return;
		}
		
		if ( /https?:\/\//.test(data) ){
			this.emit( "coverChange",data );
			return;
		}
		if(data[0] !== "/") data = "/"+data;
		this.emit( "coverChange",this.host+data );
	}
	else if(key === "uri"){
		this.emit( "file", data );
	}
	else if(key === "channels"){
		this.emit( "channelsChange", data );
		this.emit( "line3", "Channels : " + data );
	}
	else if(key === "trackType"){
		let pdata = data.replace(/audio/gi, "");
		this.emit( "encodingChange", pdata );
		this.emit( "line4", "Track Type : " + pdata );
	}
	else if(key === "position"){
		let pdata = parseInt(data)+1;
		this.emit( "songIdChange", pdata );
		let playlistlength = 1;
		if(this.data && this.data.playlistlength) playlistlength = this.data.playlistlength;
		this.emit( "line5", "Playlist : " + pdata + " / " + playlistlength );
	}
	else if(["repeat", "repeatSingle"].includes(key)){
		this.emit( "repeatChange", data );
		this.emit( "line6", "Repeat : " + data );
	}
};

volumio_listener.prototype.listen = function(){
	this._socket = io.connect(this.host);
  
	this.api_caller = setInterval( ()=>{
		if(this.waiting || this.state !== "play") return;
		this.waiting = true;
		this._socket.emit("getState");
		this._socket.emit("getQueue");
	}, this.refreshrate_ms );

	this._socket.emit("getState");
	
	this._socket.on("pushState", (data)=>{
		if(!this.firstRequestConsumed){
			this.firstRequestConsumed = true;
			this._socket.emit("getState");
			return;
		}
		this.compareData(data);
		this.waiting = false;
	})
	this._socket.emit("getQueue");
	this._socket.on("pushQueue", (resdata)=> {
		if(resdata && resdata[0]){
			let additionnalTrackData = resdata[0], filteredData = {};
			filteredData.playlistlength = resdata.length;
			this.compareData(filteredData);
		}
	});
}

// Каждую секунду: сбрасывать idle таймер + эмитить расчётный seek
volumio_listener.prototype._startSpotifyKeepAlive = function(){
	this._stopSpotifyKeepAlive();
	this._spotifyKeepAlive = setInterval(()=>{
		if(this.state !== "play"){
			this._stopSpotifyKeepAlive();
			return;
		}
		this.resetIdleTimeout();

		// Считаем текущий seek на основе последнего известного значения + прошедшее время
		if(this._spotifySeekStart !== null && this._spotifySeekTimestamp !== null){
			let elapsed = Date.now() - this._spotifySeekTimestamp;
			let interpolatedSeek = this._spotifySeekStart + elapsed;
			
			// Не выходить за пределы длительности трека
			if(this.data.duration){
				let maxSeek = this.data.duration * 1000;
				if(interpolatedSeek > maxSeek) interpolatedSeek = maxSeek;
			}

			// Временно подставляем расчётный seek для форматирования
			let realSeek = this.data.seek;
			this.data.seek = interpolatedSeek;
			this.seekFormat();
			this.data.seek = realSeek; // восстанавливаем реальное значение
			this.emit("seekChange", this.formatedSeek);
		}
	}, 1000);
}

volumio_listener.prototype._stopSpotifyKeepAlive = function(){
	if(this._spotifyKeepAlive){
		clearInterval(this._spotifyKeepAlive);
		this._spotifyKeepAlive = null;
	}
}

volumio_listener.prototype.seekFormat = function (){
	
	let ratiobar, 
		seek_string, 
		seek = this.data.seek,
		duration = this.data.duration;
		
	try{
		if(!duration) ratiobar = 0;
		else ratiobar = seek / (duration * 1000);
	}
	catch(e){
		ratiobar = 0;
	}	
	try{
		duration = new Date(duration * 1000).toISOString().substr(14, 5);
	}
	catch(e){
		duration = "00:00";
	}
	try{
		seek = new Date(seek).toISOString().substr(14, 5);
	}
	catch(e){
		seek = "";
	}
	seek_string = seek + " / "+ duration;
	this.formatedSeek = {seek_string:seek_string, ratiobar:ratiobar};
	return(this.formatedSeek);
}

volumio_listener.prototype.formatMainString = function (){
	this.formatedMainString = this.data.title + (this.data.artist?" - " + this.data.artist:"") + (this.data.album?" - " + this.data.album:"");
}

volumio_listener.prototype.watchIdleState = function(iddletime){
	this.watchingIdle = true;
	this.iddletime = iddletime;
	clearTimeout(this._iddleTimeout);
	this._iddleTimeout = setTimeout( ()=>{
		if(! this.watchingIdle ) return;
		this.iddle = true;
		this.emit("iddleStart")
	}, this.iddletime );
}

volumio_listener.prototype.resetIdleTimeout = function(){
	if(! this.watchingIdle ) return;
	if( this.iddle  ) this.emit("iddleStop");
	this.iddle = false;
	this._iddleTimeout.refresh();
}

volumio_listener.prototype.clearIdleTimeout = function(){
	this.watchingIdle = false;
	if( this.iddle  ) this.emit("iddleStop");
	this.iddle = false;
	clearTimeout(this._iddleTimeout);
}
