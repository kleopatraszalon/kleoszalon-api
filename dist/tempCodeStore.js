"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.saveCodeForEmail = saveCodeForEmail;
exports.getCodeForEmail = getCodeForEmail;
exports.consumeCode = consumeCode;
const tempCodes = new Map();
// kulcs: email
function saveCodeForEmail(email, rec) {
    tempCodes.set(email.toLowerCase(), rec);
}
function getCodeForEmail(email) {
    const item = tempCodes.get(email.toLowerCase());
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
    const item = getCodeForEmail(email);
    if (!item)
        return null;
    tempCodes.delete(email.toLowerCase());
    return item;
}
