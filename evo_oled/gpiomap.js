const fs = require("fs");
const cp = require("child_process");
const readline = require('readline');

class GpioPermissionError extends Error {}

async function readVFile() {
	
	const stream = fs.createReadStream('/sys/kernel/debug/gpio', { encoding: 'utf8' });
	const rl = readline.createInterface({ input: stream });
	
	const map = {
		gpio : {}, 
		fn : {}, 
		offset : {}
	};

	for await (const line of rl) {
		
		const regsearch = /^\sgpio-(?<offset>\d+)\s+\((?<fn>(GPIO(?<gpio>\d+)).*?|.*?)\s+\)/.exec(line)?.groups;
		
		if(!regsearch) continue;

		const offset =  regsearch.offset ? parseInt( regsearch.offset ) : null;
		const fn =  regsearch.fn ? (regsearch.fn).replace(/\s+/g, "") : null;
		const gpio =  regsearch.gpio ? parseInt(regsearch.gpio) : null;

		const obj = {offset,fn,gpio}
		
		if(gpio) map.gpio[obj.gpio] = obj;
		if(fn) map.fn[obj.fn] = obj;
		if(offset) map.offset[obj.offset] = obj;
		
	}
	
	return map;
}

// ?????? ?????????
async function getGpioMapping() {
	return {
		gpio: {
			27: { offset: 1, fn: 'GPIO27', gpio: 27 },
			24: { offset: 1, fn: 'GPIO24', gpio: 24 }
		},
		fn: {},
		offset: {}
	};
};
// ????? ?????????

module.exports = {getGpioMapping, GpioPermissionError}


