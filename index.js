/**
 * Created by Tim on 17-6-6.
 */

module.exports = PearPlayer;

var md5 = require('blueimp-md5');
var Dispatcher = require('./lib/dispatcher');
var HttpDownloader = require('./lib/http-downloader');
var RTCDownloader = require('./lib/webrtc-downloader-bin');
var getPeerId = require('./lib/peerid-generator');
var url = require('url');
var File = require('./lib/file');
var nodeFilter = require('./lib/node-filter');
var inherits = require('inherits');
var EventEmitter = require('events').EventEmitter;
var Set = require('./lib/set');

var BLOCK_LENGTH = 32 * 1024;

inherits(PearPlayer, EventEmitter);

function PearPlayer(selector,token, opts) {
    var self = this;
    if (!(self instanceof PearPlayer)) return new PearPlayer(selector, token, opts);
    EventEmitter.call(self);

    opts = opts || {};
    self.video = document.querySelector(selector);

    if (typeof selector !== 'string') throw new Error('video selector must be a string!');
    if (typeof token !== 'string') throw new Error('token must be a string!');
    // if (!(opts.type && opts.type === 'mp4')) throw new Error('only mp4 is supported!');
    if (!((opts.src && typeof opts.src === 'string') || self.video.src)) throw new Error('video src is not valid!');
    // if (!(config.token && typeof config.token === 'string')) throw new Error('token is not valid!');

    self.selector = selector;
    self.src = opts.src || self.video.src;
    self.urlObj = url.parse(self.src);
    self.token = token;
    self.useDataChannel = (opts.useDataChannel === false)? false : true;
    self.useMonitor = (opts.useMonitor === true)? true : false;
    self.autoPlay = (opts.autoplay === false)? false : true;
    self.params = opts.params || {};
    self.dataChannels = opts.dataChannels || 2;
    self.peerId = getPeerId();
    self.isPlaying = false;
    self.fileLength = 0;
    self.nodes = [];
    self.websocket = null;
    self.dispatcher = null;
    self.JDMap = {};                           //根据dc的peer_id来获取jd的map
    self.nodeSet = new Set();                  //保存node的set

    self.dispatcherConfig = {

        chunkSize: opts.chunkSize && (opts.chunkSize%BLOCK_LENGTH === 0 ? opts.chunkSize : Math.ceil(opts.chunkSize/BLOCK_LENGTH)*BLOCK_LENGTH),   //每个chunk的大小,默认1M
        interval: opts.interval,     //滑动窗口的时间间隔,单位毫秒,默认10s,
        slideInterval: opts.slideInterval,
        auto: opts.auto,
        useMonitor: self.useMonitor
    };
    console.log('self.dispatcherConfig:'+self.dispatcherConfig.chunkSize);

    self._start();

}

PearPlayer.prototype._start = function () {
    var self = this;
    if (!getBrowserRTC()) {
        self.emit('exception', {errCode: 1, errMsg: 'This browser do not support WebRTC communication'});
        alert('This browser do not support WebRTC communication');
        self.useDataChannel = false;
    }
    if (!window.WebSocket) {
        self.useDataChannel = false;
    }
    self._getNodes(self.token, function (nodes) {
        console.log('_getNodes:'+JSON.stringify(nodes));
        // nodes = [{uri: 'https://000c29d049f4.webrtc.win:64892/qq.webrtc.win/free/planet.mp4', type: 'node'}]; //test
        if (nodes) {
            self._startPlaying(nodes);
            if (self.useDataChannel) {
                self._pearSignalHandshake();
            }
        } else {
            self._fallBack();
        }
    });
};

PearPlayer.prototype._getNodes = function (token, cb) {
    var self = this;

    var postData = {
        client_ip:'127.0.0.1',
        host: self.urlObj.host,
        uri: self.urlObj.path
    };
    postData = (function(obj){
        var str = "?";

        for(var prop in obj){
            str += prop + "=" + obj[prop] + "&"
        }
        return str;
    })(postData);

    var xhr = new XMLHttpRequest();
    xhr.open("GET", 'https://api.webrtc.win:6601/v1/customer/nodes'+postData);
    xhr.timeout = 2000;
    xhr.setRequestHeader('X-Pear-Token', self.token);
    xhr.ontimeout = function() {
        // self._fallBack();
        cb(null);
    };
    xhr.onload = function () {
        if (this.status >= 200 && this.status < 300 || this.status == 304) {

            console.log(this.response);
            var res = JSON.parse(this.response);
            // console.log(res.nodes);
            if (!res.nodes){
                cb(null);
            } else {
                var nodes = res.nodes;
                var allNodes = [];
                for (var i=0; i<nodes.length; ++i){
                    var protocol = nodes[i].protocol;
                    var host = nodes[i].host;
                    var type = nodes[i].type;
                    var path = self.urlObj.host + self.urlObj.path;
                    var url = protocol+'://'+host+'/'+path;
                    if (!self.nodeSet.has(url)) {
                        allNodes.push({uri: url, type: type});
                        self.nodeSet.add(url);
                    }
                }

                // allNodes.push({uri: 'https://qq.webrtc.win/tv/pear001.mp4', type: 'node'});           //examples
                // allNodes.push({uri: 'https://qq.webrtc.win/tv/pear001.mp4', type: 'node'});           //examples
                // allNodes.push({uri: 'https://qq.webrtc.win/tv/pear001.mp4', type: 'node'});           //examples
                nodeFilter(allNodes, function (nodes, fileLength) {            //筛选出可用的节点,以及回调文件大小

                    var length = nodes.length;
                    console.log('nodes:'+JSON.stringify(nodes));

                    if (length) {
                        self.fileLength = fileLength;
                        console.log('nodeFilter fileLength:'+fileLength);
                        // self.nodes = nodes;
                        if (length === 1) {
                            // fallBack(nodes[0]);
                            cb(nodes);
                        } else {
                            cb(nodes);
                        }
                    } else {
                        // self._fallBack();
                        cb(null);
                    }
                });
            }
        } else {
            // self._fallBack();
            cb(null);
        }
    };
    xhr.send();
};

PearPlayer.prototype._fallBack = function (url) {

    if (this.isPlaying) return;
    if (url) {
        this.video.src = url;
    } else {
        this.video.src = this.src;
    }
    if (this.autoPlay) {
        this.video.play();
    }
    this.isPlaying = true;
};

PearPlayer.prototype._pearSignalHandshake = function () {
    var self = this;
    var dcCount = 0;                            //目前建立的data channel数量

    var websocket = new WebSocket('wss://signal.webrtc.win:7601/wss');
    self.websocket = websocket;
    websocket.onopen = function() {
        console.log('websocket connection opened!');

        var hash = md5(self.urlObj.host + self.urlObj.path);
        websocket.push(JSON.stringify({
            "action": "get",
            "peer_id": self.peerId,
            "host": self.urlObj.host,
            "uri": self.urlObj.path,
            "md5": hash
        }));
        // console.log('peer_id:'+self.peerId);
    };
    websocket.push = websocket.send;
    websocket.send = function(data) {
        if (websocket.readyState != 1) {
            console.warn('websocket connection is not opened yet.');
            return setTimeout(function() {
                websocket.send(data);
            }, 1000);
        }
        // console.log("send to signal is " + data);
        websocket.push(data);
    };
    websocket.onmessage = function(e) {
        var message = JSON.parse(e.data);
        console.log("[simpleRTC] websocket message is: " + JSON.stringify(message));
        // message = message.nodes[1];
        var nodes = message.nodes;
        for (var i=0;i<nodes.length;++i) {
            var node = nodes[i];
            if (!node.errorcode) {
                if (dcCount === self.dataChannels) break;
                console.log('dc message:'+JSON.stringify(node))
                if (!self.JDMap[node.peer_id]) {
                    self.JDMap[node.peer_id] = self.initDC(node);
                    dcCount ++;
                } else {
                    console.log('datachannel 重复');
                }
            } else {
                console.log('dc error message:'+JSON.stringify(message))
            }
        }
    };
};

PearPlayer.prototype.initDC = function (message) {
    var self = this;

    var dc_config = {
        peer_id: self.peerId,
        chunkSize: 32*1024,
        host: self.urlObj.host,
        uri: self.urlObj.path,
        useMonitor: self.useMonitor
    };

    var jd = new RTCDownloader(dc_config);
    jd.messageFromDC(message)
    jd.on('signal',function (message) {
        console.log('[jd] signal:' + JSON.stringify(message));
        self.websocket.send(JSON.stringify(message));
    });
    jd.on('connect',function () {

        // if (!self.isPlaying) {
        //
        //     self._startPlaying(self.fileLength, self.nodes);
        // }
        self.dispatcher.addDataChannel(jd);
        // if (self.websocket) {
        //     self.websocket.close();
        // }
    });

    return jd;
};

PearPlayer.prototype._startPlaying = function (nodes) {
    var self = this;
    console.log('start playing');
    self.dispatcherConfig.initialDownloaders = [];
    for (var i=0;i<nodes.length;++i) {
        var node = nodes[i];
        var hd = new HttpDownloader(node.uri, node.type);
        self.dispatcherConfig.initialDownloaders.push(hd);
    }
    self.dispatcherConfig.fileSize = self.fileLength;
    // self.dispatcherConfig.sortedURIs = nodes;
    var fileConfig = {
        length: self.fileLength,
        offset: 0,
        name: self.urlObj.path,
        elem: self.selector
    };

    var d = new Dispatcher(self.dispatcherConfig);
    self.dispatcher = d;

    //{errCode: 1, errMsg: 'This browser do not support WebRTC communication'}
    d.once('ready', function (chunks) {

        self.emit('begin', self.fileLength, chunks);
    });

    var file = new File(d, fileConfig);

    file.renderTo(self.selector, {autoplay: self.autoPlay});

    self.isPlaying = true;

    d.on('error', function () {
        console.log('dispatcher error!');
        // d.destroy();
        // self._fallBack();
        // var hd = new HttpDownloader(self.src, 'server');
        // // d.addNodes([{uri: self.src, type: 'server'}]);
        // d.addNode(hd);
    });
    d.on('needmorenodes', function () {
        console.log('request more nodes');
        self._getNodes(self.token, function (nodes) {
            console.log('_getNodes:'+JSON.stringify(nodes));
            if (nodes) {
                // d.addNodes(nodes);
                for (var i=0;i<nodes.length;++i) {
                    var node = nodes[i];
                    var hd = new HttpDownloader(node.uri, node.type);
                    d.addNode(hd);
                }
            } else {

            }
        });

    });
    d.on('needsource', function () {

        if (!self.nodeSet.has(self.src)) {
            var hd = new HttpDownloader(self.src, 'server');
            d.addNode(hd);
            console.log('dispatcher add source:'+self.src);
            self.nodeSet.add(self.src);
        }


    });

    d.on('needmoredatachannels', function () {
        console.log('request more datachannels');
        if (self.websocket && self.websocket.readyState === WebSocket.OPEN) {

            var hash = md5(self.urlObj.host + self.urlObj.path);
            self.websocket.push(JSON.stringify({
                "action": "get",
                "peer_id": self.peerId,
                "host": self.urlObj.host,
                "uri": self.urlObj.path,
                "md5": hash
            }));
        }
    });
    d.once('done', function () {

        self.emit('done');
    });
    d.on('downloaded', function (downloaded) {

        self.emit('progress', downloaded);
    });
    d.on('fograte', function (fogRate) {

        self.emit('fograte', fogRate);
    });

    d.on('bitfieldchange', function (bitfield) {

        self.emit('bitfieldchange', bitfield, d.chunks);
    });
    d.on('fogspeed', function (speed) {

        self.emit('fogspeed', speed);
    });
    d.on('cloudspeed', function (speed) {

        self.emit('cloudspeed', speed);
    });
    d.on('buffersources', function (bufferSources) {       //s: server   n: node  d: data channel  b: browser

        self.emit('buffersources', bufferSources);
    });
    d.on('traffic', function (mac, downloaded, type) {

        self.emit('traffic', mac, downloaded, type);
    });
};

function getBrowserRTC () {
    if (typeof window === 'undefined') return null;
    var wrtc = {
        RTCPeerConnection: window.RTCPeerConnection || window.mozRTCPeerConnection ||
        window.webkitRTCPeerConnection,
    };
    if (!wrtc.RTCPeerConnection) return null;
    return wrtc
}



/**
 * Created by snow on 17-6-28.
 */
