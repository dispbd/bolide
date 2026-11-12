-- Started from `npm run db:sql`, then edited: migrations are plain SQL.
create table "todos" (
  "id" uuid primary key,
  "title" text not null,
  "done" boolean not null default false,
  "owner_id" uuid not null,
  "created_at" timestamptz not null default now()
);

create index todos_owner on "todos" ("owner_id", "created_at");
