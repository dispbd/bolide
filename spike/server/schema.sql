set client_min_messages = warning;
create table if not exists todos (
  id uuid primary key,
  title text not null,
  done boolean not null default false,
  owner_id uuid not null
);
