'use strict';

var adapter = require('./adapter.js');
var index = require('../../runtime/http/index.js');
var runtimeString = require('../../runtime/platform/runtime-string.js');

index.setAbstractFetchFunc(fetch);
index.setAbstractConvertRequestFunc(adapter.webApiConvertRequest);
index.setAbstractConvertResponseFunc(adapter.webApiConvertResponse);
index.setAbstractConvertHeadersFunc(adapter.webApiConvertHeaders);
runtimeString.setAbstractRuntimeString(adapter.webApiRuntimeString);
//# sourceMappingURL=index.js.map
