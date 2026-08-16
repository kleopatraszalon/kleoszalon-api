'use strict';

const SOURCE_DOCUMENT='KLEO VIR inventory operational supplement';
function acceptance(requirementId,index,given,when,then,method='integration'){
  const suffix=String(index+1).padStart(2,'0');const id=`${requirementId}-AC-${suffix}`;
  return{id,given,when,then,verification:{method,test_case_id:`TC-${id}`,automation_status:'automated',test_refs:['tests/inventory_lot_fefo.integration.js'],evidence_required:true}};
}
module.exports={
  schema_version:'1.0.0',
  baseline:{id:'KLEO-VIR-INVENTORY-SUPPLEMENT-2026-08-16',approved_on:'2026-08-16',scope:'Lejárati tételkezelés és FEFO működés, amely a futó VIR része, de az eredeti és első operatív baseline-ból hiányzott.'},
  requirements:[{
    id:'KLEO-FUN-INV-004',area:'Logisztika',title:'Lejárati tételkezelés és FEFO készletfelhasználás',type:'functional',
    source:{document:SOURCE_DOCUMENT,version:'1',kind:'operational-supplement',approved_on:'2026-08-16',rationale:'A VIR tétel-, lejárat- és FEFO-kezelést, valamint külön PostgreSQL integrációs tesztet tartalmaz, de erre korábban nem létezett kanonikus KLEO-követelmény.'},
    priority:'must',owner_role:'Inventory Owner',lifecycle_status:'approved',
    statement:'A tétel- és lejáratkövetett termék kiadásakor a rendszer a nem lejárt készletből a legkorábban lejáró használható tételt választja először, lejárt készletet automatikusan nem használ fel, és elégtelen használható készlet esetén tranzakcióbiztosan megtagadja a kiadást.',
    acceptance_criteria:[
      acceptance('KLEO-FUN-INV-004',0,'Adott ugyanabból a termékből egy lejárt, egy 10 nap múlva és egy 100 nap múlva lejáró készlettétel','A rendszer a szükséges mennyiséget automatikusan kiadja','A kiadás először a 10 nap múlva lejáró nem lejárt tételt fogyasztja, majd a későbbit; a lejárt tétel mennyisége változatlan marad'),
      acceptance('KLEO-FUN-INV-004',1,'Adott olyan aggregált készlet, amely mennyiségileg elegendő lenne, de annak egy része már lejárt','A felhasználó a ténylegesen használható készletnél nagyobb kiadást kér','A rendszer INVENTORY_FEFO_INSUFFICIENT_USABLE_STOCK hibával elutasítja a műveletet, és rollback után egyik tétel készlete sem sérül')
    ]
  }]
};
