import fs from 'node:fs';
import path from 'node:path';

const root=process.cwd();
const generated=path.join(root,'.nav-build','nav');
const target=path.join(root,'dist','nav');

if(!fs.existsSync(generated))throw new Error('A NAV XSD build assetek hiányoznak. Előbb futtasd a prepare-nav-xsd-assets.mjs scriptet.');
fs.mkdirSync(target,{recursive:true});
fs.cpSync(path.join(generated,'xsd'),path.join(target,'xsd'),{recursive:true});
fs.cpSync(path.join(generated,'vendor'),path.join(target,'vendor'),{recursive:true});
fs.cpSync(path.join(root,'src','sql'),path.join(root,'dist','sql'),{recursive:true});
console.log('[NAV XSD] runtime assets copied to dist/nav.');
