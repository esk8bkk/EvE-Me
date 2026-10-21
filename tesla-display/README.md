# EvE Me — จอแสดงผลบนรถ Tesla

คุยกับ Grok Bot บนมือถือ → Grok Bot ส่งข้อความ/การ์ด/ข้อมูลเที่ยวบิน (POST) ไปที่เซิร์ฟเวอร์เล็ก ๆ บน Render → หน้าเว็บที่เปิดค้างไว้ในเบราว์เซอร์ของ Tesla อัปเดตทันที (Server-Sent Events, ถ้า SSE ใช้ไม่ได้จะ poll ทุก 5 วินาที) ไม่ต้องแตะหน้าจอ

## ไฟล์
- `server.js` — Express + SSE เก็บ 20 รายการล่าสุดในหน่วยความจำ (รีสตาร์ทแล้วหาย)
- `public/index.html` — หน้าจอ (ธีมมืด, สีเน้น #F5B83D, รองรับภาษาไทย, มาสคอตเคลื่อนไหว)
- `render.yaml` — Blueprint สำหรับ Render (service ชื่อ `evae-me`)

## Endpoints
| Method | Path | Auth |
|---|---|---|
| POST | `/api/push` body `{type:'message'|'card'|'flight', title, body, meta}` | `Authorization: Bearer $PUSH_TOKEN` |
| GET | `/api/stream?k=VIEW_KEY` (SSE) | VIEW_KEY |
| GET | `/api/latest?k=VIEW_KEY` | VIEW_KEY |
| GET | `/?k=VIEW_KEY` หน้าจอแสดงผล | VIEW_KEY |
| GET | `/healthz` | – |

flight ใช้ `meta: {from, to, dep, arr}`

## Deploy บน Render
1. สร้างคีย์ลับ 2 ตัว เช่น `openssl rand -hex 24` (ตัวหนึ่งเป็น PUSH_TOKEN อีกตัวเป็น VIEW_KEY)
2. อัปโหลดโฟลเดอร์นี้ขึ้น GitHub (repo private ได้)
3. ใน Render: **New → Blueprint** → เลือก repo → Render อ่าน `render.yaml` แล้วสร้าง web service `evae-me`
   (หรือ **New → Web Service**: Build `npm install`, Start `npm start`, Runtime Node)
4. ใส่ค่า Environment `PUSH_TOKEN` และ `VIEW_KEY` (ตั้ง sync:false ไว้ จึงต้องกรอกเองในหน้า Render)
5. รอ deploy เสร็จ จะได้ URL `https://evae-me.onrender.com` (หรือชื่อที่ Render กำหนด)

## เปิดบน Tesla
เปิดเบราว์เซอร์ในรถ → ไปที่ `https://<app>.onrender.com/?k=<VIEW_KEY>` → กด Bookmark/Favorite ไว้
จุดสีเหลืองมุมขวาบน = เชื่อมต่อสด, สีแดง = หลุด (มาสคอตจะหลับตา) หน้าจอจะหรี่ลงเองถ้าไม่มีข้อความใหม่ 10 นาที

## ทดลองส่งข้อความ
```bash
curl -X POST https://<app>.onrender.com/api/push \
  -H "Authorization: Bearer $PUSH_TOKEN" -H "Content-Type: application/json" \
  -d '{"type":"flight","title":"TG465 Bangkok → Melbourne","body":"Gate C4","meta":{"from":"BKK","to":"MEL","dep":"19:40","arr":"08:30"}}'

curl -X POST https://<app>.onrender.com/api/push \
  -H "Authorization: Bearer $PUSH_TOKEN" -H "Content-Type: application/json" \
  -d '{"type":"message","title":"สวัสดีค่ะ","body":"ข้อความจาก Grok Bot"}'
```

## ส่งจาก Grok Bot
บอก Grok Bot ได้เลย เช่น "ส่งเที่ยวบินพรุ่งนี้ไปจอ Tesla" — บอทจะรันคำสั่ง curl ด้านบนให้ (ต้องให้บอทรู้ URL และ PUSH_TOKEN)

## ข้อควรรู้
- **Render free tier จะหลับหลังไม่มีคนใช้ ~15 นาที** การเปิดครั้งแรกอาจรอ ~50 วินาที และข้อความในหน่วยความจำหายเมื่อหลับ/รีสตาร์ท แนะนำแพ็กเกจ Starter (ไม่หลับ) หรือตั้ง cron/uptime ping ไปที่ `/healthz` ทุก ~10 นาที
- อย่าแชร์ลิงก์ที่มี `?k=` ให้ผู้อื่น
- ไม่มีการตอบโต้บนจอ ปลอดภัยเมื่อขับรถ (Tesla อาจล็อกเบราว์เซอร์ขณะขับ)
