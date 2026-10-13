-- Edit a saved meal atomically (rename + upsert/delete items). Safe to re-run.
-- p_items: [{"id":optional,"name":..,"protein":..,"carbs":..,"fat":..,"calories":optional}], order = position.
create or replace function public.update_saved_meal(p_id bigint, p_name text, p_items jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); it jsonb; pos int := 0; keep bigint[] := '{}'; iid bigint;
        p numeric; c numeric; f numeric; k numeric; nm text;
begin
  if uid is null or not exists (select 1 from profiles where id = uid and approved) then raise exception 'not allowed'; end if;
  if not exists (select 1 from saved_meals where id = p_id and user_id = uid) then raise exception 'saved meal not found'; end if;
  if coalesce(length(trim(p_name)), 0) = 0 then raise exception 'meal name required'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then raise exception 'add at least one item'; end if;
  update saved_meals set name = left(trim(p_name), 100) where id = p_id;
  for it in select value from jsonb_array_elements(p_items) loop
    nm := left(trim(coalesce(it->>'name', '')), 200);
    if nm = '' then raise exception 'every item needs a name'; end if;
    p := round(coalesce(nullif(it->>'protein','')::numeric, 0), 1); c := round(coalesce(nullif(it->>'carbs','')::numeric, 0), 1);
    f := round(coalesce(nullif(it->>'fat','')::numeric, 0), 1);
    k := coalesce(round(nullif(it->>'calories','')::numeric, 1), round(4*p + 4*c + 9*f, 1));
    iid := nullif(it->>'id','')::bigint;
    if iid is not null then
      if not exists (select 1 from saved_meal_items where id = iid and saved_meal_id = p_id) then raise exception 'item % is not in this meal', iid; end if;
      update saved_meal_items set name = nm, protein = p, carbs = c, fat = f, calories = k, position = pos where id = iid;
    else
      insert into saved_meal_items(saved_meal_id, name, protein, carbs, fat, calories, position)
      values (p_id, nm, p, c, f, k, pos) returning id into iid;
    end if;
    keep := keep || iid; pos := pos + 1;
  end loop;
  delete from saved_meal_items where saved_meal_id = p_id and not (id = any(keep));
  return pos;
end $$;
revoke all on function public.update_saved_meal(bigint, text, jsonb) from public, anon;
grant execute on function public.update_saved_meal(bigint, text, jsonb) to authenticated;
