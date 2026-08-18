'use strict';
process.env.TS_NODE_PROJECT=process.env.TS_NODE_PROJECT||'tsconfig.server.json';
require('ts-node/register/transpile-only');
const test=require('node:test');
const assert=require('node:assert/strict');
const academy=require('../src/knowledge/catalogAcademyLevels2026.ts');

test('academy has three proficiency levels and broad profession coverage',()=>{
 assert.deepEqual(academy.academyLevels.map(x=>x.key),['beginner','advanced','expert']);
 assert.equal(academy.academyProfessions.length,13);
 assert.equal(academy.academyMaterials.length,117);
 assert.equal(academy.academyQuizQuestions.length,585);
});

test('every profession has nine materials and fifteen questions per level',()=>{
 for(const profession of academy.academyProfessions){
  assert.equal(academy.academyMaterialsForProfession(profession.key).length,9,profession.key);
  for(const level of academy.academyLevels){
   assert.equal(academy.academyQuestionsForProfession(profession.key,level.key).length,15,`${profession.key}/${level.key}`);
  }
 }
});

test('known Kleopatra roles resolve to the intended academy professions',()=>{
 assert.equal(academy.academyProfessionForRole('TOP fodrász').key,'hair');
 assert.equal(academy.academyProfessionForRole('Kozmetikus technikus').key,'cosmetic');
 assert.equal(academy.academyProfessionForRole('Kéz- és lábápoló technikus').key,'nail');
 assert.equal(academy.academyProfessionForRole('Masszőr').key,'massage');
 assert.equal(academy.academyProfessionForRole('Szolárium kezelő').key,'solarium');
 assert.equal(academy.academyProfessionForRole('Műszakvezető').key,'management');
 assert.equal(academy.academyProfessionForRole('Készlet- és beszerzési munkatárs').key,'inventory');
});
