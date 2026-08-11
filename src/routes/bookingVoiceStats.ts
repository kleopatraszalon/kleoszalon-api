import { Router } from "express";
import db from "../db";
import ensureBookingVoiceStats from "../booking/ensureBookingVoiceStats";

const router = Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const pct = (part: number, total: number) => total > 0 ? Math.round((part / total) * 1000) / 10 : 0;
const count = (value: unknown) => Number(value || 0);
const appointmentCreated = `COALESCE(NULLIF(to_jsonb(a)->>'created_at','')::timestamptz,a.start_time)`;

router.get("/", async (req, res) => {
  try {
    await ensureBookingVoiceStats();
    const days = Math.min(365, Math.max(1, Number(req.query.days || 30) || 30));
    const locationId = String(req.query.location_id || "").trim() || null;
    if (locationId && !UUID_RE.test(locationId)) return res.status(400).json({ error: "Érvénytelen telephelyazonosító." });
    const to = new Date();
    const from = new Date(to.getTime() - days * 86400000);
    const params = [from.toISOString(), to.toISOString(), locationId];

    const [eventSummary, bookingSummary, intents, locations, eventDaily, bookingDaily, recent, services] = await Promise.all([
      db.query(`SELECT
          count(*)::int voice_requests,
          count(*) FILTER(WHERE v.recognized)::int recognized,
          count(*) FILTER(WHERE v.ai_used)::int ai_used,
          count(*) FILTER(WHERE v.intent='book')::int book_intents,
          count(*) FILTER(WHERE v.intent='book' AND v.recognized)::int recognized_book_intents,
          count(*) FILTER(WHERE v.intent='waitlist')::int waitlist_intents,
          count(*) FILTER(WHERE v.intent='cancel')::int cancel_intents,
          count(*) FILTER(WHERE v.intent='book' AND v.recognized AND EXISTS(
            SELECT 1 FROM appointments a WHERE a.voice_event_id=v.id
          ))::int exact_book_conversions,
          count(*) FILTER(WHERE EXISTS(
            SELECT 1 FROM booking_waitlist w WHERE w.voice_event_id=v.id
          ))::int exact_waitlist_conversions,
          COALESCE(avg(v.transcript_length),0)::numeric avg_transcript_length
        FROM booking_voice_events v
        WHERE v.created_at >= $1::timestamptz AND v.created_at < $2::timestamptz
          AND ($3::uuid IS NULL OR v.location_id=$3::uuid)`, params),
      db.query(`SELECT
          count(*) FILTER(WHERE a.booking_source='online_voice')::int voice_booking_records,
          count(*) FILTER(WHERE a.booking_source='online_voice' AND a.voice_event_id IS NOT NULL)::int correlated_voice_booking_records,
          count(*) FILTER(WHERE a.booking_source='online_voice' AND a.status NOT IN ('cancelled','canceled'))::int voice_bookings,
          count(*) FILTER(WHERE a.booking_source='online' AND a.status NOT IN ('cancelled','canceled'))::int online_bookings
        FROM appointments a
        WHERE ${appointmentCreated} >= $1::timestamptz AND ${appointmentCreated} < $2::timestamptz
          AND ($3::uuid IS NULL OR a.location_id=$3::uuid)`, params),
      db.query(`SELECT intent,count(*)::int total,count(*) FILTER(WHERE recognized)::int recognized,count(*) FILTER(WHERE ai_used)::int ai_used
        FROM booking_voice_events
        WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz
          AND ($3::uuid IS NULL OR location_id=$3::uuid)
        GROUP BY intent ORDER BY total DESC,intent`, params),
      db.query(`SELECT l.id::text location_id,l.name,
          (SELECT count(*)::int FROM booking_voice_events v WHERE v.location_id=l.id AND v.created_at >= $1::timestamptz AND v.created_at < $2::timestamptz) voice_requests,
          (SELECT count(*)::int FROM booking_voice_events v WHERE v.location_id=l.id AND v.recognized AND v.created_at >= $1::timestamptz AND v.created_at < $2::timestamptz) recognized,
          (SELECT count(*)::int FROM booking_voice_events v WHERE v.location_id=l.id AND v.intent='book' AND v.recognized AND v.created_at >= $1::timestamptz AND v.created_at < $2::timestamptz AND EXISTS(SELECT 1 FROM appointments ax WHERE ax.voice_event_id=v.id)) exact_book_conversions,
          (SELECT count(*)::int FROM appointments a WHERE a.location_id=l.id AND a.booking_source='online_voice' AND ${appointmentCreated} >= $1::timestamptz AND ${appointmentCreated} < $2::timestamptz) voice_booking_records,
          (SELECT count(*)::int FROM appointments a WHERE a.location_id=l.id AND a.booking_source='online_voice' AND a.voice_event_id IS NOT NULL AND ${appointmentCreated} >= $1::timestamptz AND ${appointmentCreated} < $2::timestamptz) correlated_voice_booking_records,
          (SELECT count(*)::int FROM appointments a WHERE a.location_id=l.id AND a.booking_source='online_voice' AND a.status NOT IN ('cancelled','canceled') AND ${appointmentCreated} >= $1::timestamptz AND ${appointmentCreated} < $2::timestamptz) voice_bookings,
          (SELECT count(*)::int FROM appointments a WHERE a.location_id=l.id AND a.booking_source='online' AND a.status NOT IN ('cancelled','canceled') AND ${appointmentCreated} >= $1::timestamptz AND ${appointmentCreated} < $2::timestamptz) online_bookings
        FROM locations l
        WHERE COALESCE(l.is_active,true)=true AND ($3::uuid IS NULL OR l.id=$3::uuid)
        ORDER BY voice_requests DESC,voice_bookings DESC,l.name`, params),
      db.query(`SELECT to_char(v.created_at AT TIME ZONE 'Europe/Budapest','YYYY-MM-DD') date,
          count(*)::int voice_requests,
          count(*) FILTER(WHERE v.recognized)::int recognized,
          count(*) FILTER(WHERE v.ai_used)::int ai_used,
          count(*) FILTER(WHERE v.intent='book' AND v.recognized AND EXISTS(SELECT 1 FROM appointments a WHERE a.voice_event_id=v.id))::int exact_book_conversions
        FROM booking_voice_events v
        WHERE v.created_at >= $1::timestamptz AND v.created_at < $2::timestamptz
          AND ($3::uuid IS NULL OR v.location_id=$3::uuid)
        GROUP BY 1 ORDER BY 1`, params),
      db.query(`SELECT to_char(${appointmentCreated} AT TIME ZONE 'Europe/Budapest','YYYY-MM-DD') date,
          count(*) FILTER(WHERE a.booking_source='online_voice' AND a.status NOT IN ('cancelled','canceled'))::int voice_bookings,
          count(*) FILTER(WHERE a.booking_source='online' AND a.status NOT IN ('cancelled','canceled'))::int online_bookings
        FROM appointments a
        WHERE ${appointmentCreated} >= $1::timestamptz AND ${appointmentCreated} < $2::timestamptz
          AND ($3::uuid IS NULL OR a.location_id=$3::uuid)
          AND a.booking_source IN ('online_voice','online')
        GROUP BY 1 ORDER BY 1`, params),
      db.query(`SELECT v.id::text,v.created_at,v.intent,v.recognized,v.ai_used,v.transcript_length,v.requested_date,v.requested_time,v.preferred_period,v.missing_fields,
          l.name location_name,e.full_name employee_name,cardinality(v.service_ids)::int service_count,
          EXISTS(SELECT 1 FROM appointments a WHERE a.voice_event_id=v.id) converted_to_booking,
          (SELECT a.id::text FROM appointments a WHERE a.voice_event_id=v.id ORDER BY ${appointmentCreated} DESC LIMIT 1) appointment_id,
          (SELECT a.status FROM appointments a WHERE a.voice_event_id=v.id ORDER BY ${appointmentCreated} DESC LIMIT 1) booking_status,
          EXISTS(SELECT 1 FROM booking_waitlist w WHERE w.voice_event_id=v.id) converted_to_waitlist,
          (SELECT w.id::text FROM booking_waitlist w WHERE w.voice_event_id=v.id ORDER BY w.created_at DESC LIMIT 1) waitlist_id
        FROM booking_voice_events v
        LEFT JOIN locations l ON l.id=v.location_id
        LEFT JOIN employees e ON e.id=v.employee_id
        WHERE v.created_at >= $1::timestamptz AND v.created_at < $2::timestamptz
          AND ($3::uuid IS NULL OR v.location_id=$3::uuid)
        ORDER BY v.created_at DESC LIMIT 60`, params),
      db.query(`SELECT s.id::text service_id,s.name,count(*)::int requests
        FROM booking_voice_events v
        CROSS JOIN LATERAL unnest(v.service_ids) sid
        JOIN services s ON s.id=sid
        WHERE v.created_at >= $1::timestamptz AND v.created_at < $2::timestamptz
          AND ($3::uuid IS NULL OR v.location_id=$3::uuid)
        GROUP BY s.id,s.name ORDER BY requests DESC,s.name LIMIT 12`, params),
    ]);

    let ai = { calls: 0, input_tokens: 0, output_tokens: 0, estimated_cost_usd: 0 };
    try {
      const r = await db.query(`SELECT count(*)::int calls,COALESCE(sum(input_tokens),0)::bigint input_tokens,COALESCE(sum(output_tokens),0)::bigint output_tokens,COALESCE(sum(estimated_cost_usd),0)::numeric estimated_cost_usd
        FROM ai_usage_log WHERE user_key LIKE 'public-booking-voice:%' AND created_at >= $1::timestamptz AND created_at < $2::timestamptz`, [from.toISOString(), to.toISOString()]);
      ai = {
        calls: count(r.rows[0]?.calls),
        input_tokens: count(r.rows[0]?.input_tokens),
        output_tokens: count(r.rows[0]?.output_tokens),
        estimated_cost_usd: Number(r.rows[0]?.estimated_cost_usd || 0),
      };
    } catch (error: any) {
      if (!['42P01','42703'].includes(String(error?.code || ''))) throw error;
    }

    let waitlist = { voice_waitlist: 0, online_waitlist: 0, correlated_voice_waitlist:0 };
    try {
      const r = await db.query(`SELECT
          count(*) FILTER(WHERE source='online_voice')::int voice_waitlist,
          count(*) FILTER(WHERE source='online_voice' AND voice_event_id IS NOT NULL)::int correlated_voice_waitlist,
          count(*) FILTER(WHERE source='online')::int online_waitlist
        FROM booking_waitlist
        WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz
          AND ($3::uuid IS NULL OR location_id=$3::uuid)`, params);
      waitlist = { voice_waitlist: count(r.rows[0]?.voice_waitlist), correlated_voice_waitlist:count(r.rows[0]?.correlated_voice_waitlist), online_waitlist: count(r.rows[0]?.online_waitlist) };
    } catch (error: any) {
      if (!['42P01','42703'].includes(String(error?.code || ''))) throw error;
    }

    const ev = eventSummary.rows[0] || {};
    const bk = bookingSummary.rows[0] || {};
    const voiceRequests = count(ev.voice_requests);
    const recognized = count(ev.recognized);
    const voiceBookIntents = count(ev.recognized_book_intents);
    const exactBookConversions=count(ev.exact_book_conversions);
    const voiceBookings = count(bk.voice_bookings);
    const onlineBookings = count(bk.online_bookings);
    const voiceBookingRecords=count(bk.voice_booking_records);
    const correlatedVoiceBookingRecords=count(bk.correlated_voice_booking_records);

    const daily = new Map<string, any>();
    for (let i = days - 1; i >= 0; i -= 1) {
      const d = new Date(to.getTime() - i * 86400000);
      const key = new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Budapest',year:'numeric',month:'2-digit',day:'2-digit'}).format(d);
      daily.set(key,{date:key,voice_requests:0,recognized:0,ai_used:0,exact_book_conversions:0,voice_bookings:0,online_bookings:0});
    }
    eventDaily.rows.forEach((r:any)=>daily.set(String(r.date),{...(daily.get(String(r.date))||{date:String(r.date)}),voice_requests:count(r.voice_requests),recognized:count(r.recognized),ai_used:count(r.ai_used),exact_book_conversions:count(r.exact_book_conversions)}));
    bookingDaily.rows.forEach((r:any)=>daily.set(String(r.date),{...(daily.get(String(r.date))||{date:String(r.date)}),voice_bookings:count(r.voice_bookings),online_bookings:count(r.online_bookings)}));

    res.json({
      range:{days,from:from.toISOString(),to:to.toISOString(),location_id:locationId},
      summary:{
        voice_requests:voiceRequests,
        recognized,
        recognition_rate:pct(recognized,voiceRequests),
        ai_used:count(ev.ai_used),
        ai_share:pct(count(ev.ai_used),voiceRequests),
        voice_book_intents:voiceBookIntents,
        voice_booking_conversions:exactBookConversions,
        conversion_rate:pct(exactBookConversions,voiceBookIntents),
        legacy_aggregate_conversion_rate:pct(voiceBookings,voiceBookIntents),
        voice_bookings:voiceBookings,
        voice_booking_records:voiceBookingRecords,
        correlated_voice_booking_records:correlatedVoiceBookingRecords,
        conversion_tracking_coverage:pct(correlatedVoiceBookingRecords,voiceBookingRecords),
        online_bookings:onlineBookings,
        voice_booking_share:pct(voiceBookings,voiceBookings+onlineBookings),
        voice_waitlist:waitlist.voice_waitlist,
        correlated_voice_waitlist:waitlist.correlated_voice_waitlist,
        voice_waitlist_conversions:count(ev.exact_waitlist_conversions),
        online_waitlist:waitlist.online_waitlist,
        avg_transcript_length:Math.round(Number(ev.avg_transcript_length||0)),
      },
      ai,
      intents:intents.rows,
      locations:locations.rows.map((r:any)=>({
        ...r,
        voice_requests:count(r.voice_requests),
        recognized:count(r.recognized),
        exact_book_conversions:count(r.exact_book_conversions),
        voice_bookings:count(r.voice_bookings),
        online_bookings:count(r.online_bookings),
        voice_booking_records:count(r.voice_booking_records),
        correlated_voice_booking_records:count(r.correlated_voice_booking_records),
        recognition_rate:pct(count(r.recognized),count(r.voice_requests)),
        conversion_rate:pct(count(r.exact_book_conversions),count(r.recognized)),
        conversion_tracking_coverage:pct(count(r.correlated_voice_booking_records),count(r.voice_booking_records)),
      })),
      daily:Array.from(daily.values()).sort((a,b)=>String(a.date).localeCompare(String(b.date))),
      top_services:services.rows,
      recent:recent.rows,
      tracking:{mode:'exact_voice_event_id',historical_uncorrelated_records:Math.max(0,voiceBookingRecords-correlatedVoiceBookingRecords)},
      privacy:{transcripts_stored:process.env.BOOKING_VOICE_STORE_TRANSCRIPTS==='1',recent_transcripts_exposed:false},
    });
  } catch (error:any) {
    console.error('GET booking voice stats:',error);
    res.status(500).json({error:'A Voice Booking statisztika nem tölthető be.',detail:process.env.NODE_ENV==='development'?String(error?.message||error):undefined});
  }
});

export default router;
