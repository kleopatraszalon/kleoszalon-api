const fs=require('fs');
const p='package-lock.json';
const lock=JSON.parse(fs.readFileSync(p,'utf8'));
if(!lock.packages||!lock.packages['']) throw new Error('Hiányzó package-lock gyökér');
lock.packages[''].devDependencies=lock.packages[''].devDependencies||{};
lock.packages[''].devDependencies['@types/multer']='^2.0.2';
fs.writeFileSync(p,JSON.stringify(lock,null,2)+'\n');
