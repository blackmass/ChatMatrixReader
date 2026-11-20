importScripts('probe.js');
probe(self).then(r => postMessage(r), e => postMessage(['probe failed: ' + e]));
