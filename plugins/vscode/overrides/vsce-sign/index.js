"use strict";

function unavailable() {
  throw new Error("VSIX signing is not available in this install");
}

module.exports = {
  verify: unavailable,
  generateManifest: unavailable,
  zip: unavailable,
  ReturnCode: {},
  ExtensionSignatureVerificationCode: { Success: "Success" },
  ExtensionSignatureVerificationResult: function ExtensionSignatureVerificationResult() {},
};
