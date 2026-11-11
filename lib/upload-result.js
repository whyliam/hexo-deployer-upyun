'use strict';

// UPYUN returns image metadata for successful image uploads, true for other files.
module.exports = function isUploadResult(result) {
  return result === true || Boolean(result && typeof result === 'object'
    && typeof result['file-type'] === 'string'
    && Number.isFinite(result.width) && Number.isFinite(result.height));
};
