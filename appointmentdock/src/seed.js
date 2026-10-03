// Demo barbershop so the platform has something to click through.
export function seedDemo(db) {
  const now = Date.now();
  const bizId = Number(db.prepare(`INSERT INTO businesses (slug, name, industry, timezone, phone, address, about, brand_color, created_at)
    VALUES ('demo', 'Fox River Barber Co.', 'Barbershop', 'America/Chicago', '(630) 555-0142', '123 Main St, Geneva, IL',
    'Classic cuts, hot towel shaves and beard work. Walk-ins welcome when chairs are open.', '#1f6f5c', ?)`).run(now).lastInsertRowid);

  const svc = db.prepare('INSERT INTO services (business_id, name, description, category, duration_min, buffer_min, price_cents, sort) VALUES (?,?,?,?,?,?,?,?)');
  const services = [
    ['Haircut', 'Scissor or clipper cut, wash and style.', 'Hair', 30, 5, 3500, 1],
    ['Skin fade', 'Bald fade blended to your length on top.', 'Hair', 45, 5, 4000, 2],
    ['Beard trim', 'Shape, line-up and hot towel.', 'Beard', 20, 0, 2000, 3],
    ['Hot towel shave', 'Straight-razor shave with hot towels.', 'Beard', 40, 5, 4500, 4],
    ['Kids cut (12 & under)', '', 'Hair', 25, 5, 2500, 5],
  ].map((s) => Number(svc.run(bizId, ...s).lastInsertRowid));

  const st = db.prepare('INSERT INTO staff (business_id, name, title, bio, sort) VALUES (?,?,?,?,?)');
  const staff = [
    ['Marco', 'Owner / Master barber', '15 years behind the chair. Fades and classic cuts.', 1],
    ['Jess', 'Barber', 'Beard specialist and straight-razor shaves.', 2],
    ['Dee', 'Barber', 'Kids cuts and textured hair.', 3],
  ].map((s) => Number(st.run(bizId, ...s).lastInsertRowid));

  const link = db.prepare('INSERT INTO staff_services (staff_id, service_id) VALUES (?,?)');
  for (const s of services) { link.run(staff[0], s); link.run(staff[2], s); }
  for (const s of [services[0], services[2], services[3]]) link.run(staff[1], s);

  const hrs = db.prepare('INSERT INTO staff_hours (staff_id, weekday, start_min, end_min) VALUES (?,?,?,?)');
  for (const d of [2, 3, 4, 5]) { hrs.run(staff[0], d, 540, 720); hrs.run(staff[0], d, 780, 1080); }
  hrs.run(staff[0], 6, 480, 900);
  for (const d of [1, 2, 3, 4, 5]) hrs.run(staff[1], d, 600, 1140);
  for (const d of [3, 4, 5, 6]) hrs.run(staff[2], d, 540, 1020);
  return bizId;
}
