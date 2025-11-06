"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.saveCodeForEmail = saveCodeForEmail;
exports.getCodeForEmail = getCodeForEmail;
exports.consumeCode = consumeCode;
var tempCodes = new Map();
// kulcs: email
function saveCodeForEmail(email, rec) {
    tempCodes.set(email.toLowerCase(), rec);
}
function getCodeForEmail(email) {
    var item = tempCodes.get(email.toLowerCase());
    if (!item)
        return null;
    // lejárt?
    if (Date.now() > item.expiresAt) {
        tempCodes.delete(email.toLowerCase());
        return null;
    }
    return item;
}
function consumeCode(email) {
    var item = getCodeForEmail(email);
    if (!item)
        return null;
    tempCodes.delete(email.toLowerCase());
    return item;
}
