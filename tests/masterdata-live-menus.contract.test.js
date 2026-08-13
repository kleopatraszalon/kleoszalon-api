const fs=require('fs');
const path=require('path');
const read=(p)=>fs.readFileSync(path.join(process.cwd(),p),'utf8');

describe('Master data live menu contract',()=>{
  test('migration activates requested master data menus',()=>{
    const sql=read('src/sql/20260813_MASTERDATA_LIVE_MENUS_V2.sql');
    expect(sql).toContain("masterdata.user-groups");
    expect(sql).toContain("/admin/access-control");
    expect(sql).toContain("masterdata.users");
    expect(sql).toContain("/employees");
    expect(sql).toContain("masterdata.discounts");
    expect(sql).toContain("/spec/discounts");
    expect(sql).toContain("masterdata.warehouses");
    expect(sql).toContain("/masterdata/warehouses");
    expect(sql).toContain("Vendégszámla-tranzakciótípusok");
    expect(sql).toContain("/spec/guest-account-transaction-types");
  });

  test('discount and guest account type modules carry specification fields',()=>{
    const sql=read('src/sql/20260813_MASTERDATA_LIVE_MENUS_V2.sql');
    for(const field of ['discount_type','service_value','product_value','service_category','product_type','valid_from','valid_until','time_from','time_to']) expect(sql).toContain(field);
    expect(sql).toContain('financial_transaction_type');
    expect(sql).toContain('Spec. 3.12. Kedvezmények');
    expect(sql).toContain('Spec. 3.21. Vendég számla tranzakciók');
  });

  test('bootstrap runs the live menu migration',()=>{
    const bootstrap=read('src/virSpec/ensureVirSpecModules.ts');
    expect(bootstrap).toContain('20260813_MASTERDATA_LIVE_MENUS_V2.sql');
  });
});
