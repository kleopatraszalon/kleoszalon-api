type Queryable={query:(sql:string,params?:any[])=>Promise<any>};

const purposes:Record<string,string>={
  marketing_consent:"marketing",
  email_consent:"marketing_email",
  sms_consent:"marketing_sms",
  phone_consent:"marketing_phone",
};

export async function recordClientConsentEvents(db:Queryable,input:{clientId:string;current:any;previous?:any|null;changedFields:string[];actor:string;evidence?:Record<string,unknown>}){
  const noticeVersion=String(input.current?.privacy_notice_version||"").trim();
  const source=String(input.current?.consent_source||"crm").trim()||"crm";
  const notice=noticeVersion?(await db.query(`SELECT id FROM gdpr_notice_versions WHERE version=$1 ORDER BY CASE WHEN status='active' THEN 0 ELSE 1 END,effective_from DESC LIMIT 1`,[noticeVersion])).rows[0]:null;
  for(const field of input.changedFields){
    const purpose=purposes[field];if(!purpose)continue;
    const granted=Boolean(input.current?.[field]);
    const wasGranted=input.previous?Boolean(input.previous?.[field]):false;
    const status=granted?"granted":input.previous&&wasGranted?"withdrawn":"refused";
    const evidence={channel:field,privacy_notice_version:noticeVersion||null,notice_registered:Boolean(notice?.id),...input.evidence};
    await db.query(`INSERT INTO gdpr_consents(subject_ref,purpose,notice_version_id,status,captured_at,withdrawn_at,source,evidence,created_by) VALUES($1,$2,$3,$4,now(),CASE WHEN $4='withdrawn' THEN now() END,$5,$6::jsonb,$7)`,[`client:${input.clientId}`,purpose,notice?.id||null,status,source,JSON.stringify(evidence),input.actor]);
  }
}
