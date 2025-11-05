import { webApiConvertRequest, webApiConvertResponse, webApiConvertHeaders } from '../web-api/adapter.mjs';
import { workerRuntimeString } from './adapter.mjs';
import { setAbstractFetchFunc, setAbstractConvertRequestFunc, setAbstractConvertResponseFunc, setAbstractConvertHeadersFunc } from '../../runtime/http/index.mjs';
import { setAbstractRuntimeString } from '../../runtime/platform/runtime-string.mjs';

setAbstractFetchFunc(fetch);
setAbstractConvertRequestFunc(webApiConvertRequest);
setAbstractConvertResponseFunc(webApiConvertResponse);
setAbstractConvertHeadersFunc(webApiConvertHeaders);
setAbstractRuntimeString(workerRuntimeString);
//# sourceMappingURL=index.mjs.map
