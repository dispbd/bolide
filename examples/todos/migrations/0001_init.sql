-- Started from `npm run db:sql`, then edited: migrations are plain SQL.
create table "lists" (
  "id" uuid primary key,
  "name" text not null,
  "created_at" timestamptz not null default now()
);

create table "members" (
  "id" text primary key,
  "list_id" uuid not null references "lists" ("id"),
  "user_id" uuid not null
);

create table "todos" (
  "id" uuid primary key,
  "list_id" uuid not null references "lists" ("id"),
  "title" text not null,
  "done" boolean not null default false,
  "created_at" timestamptz not null default now()
);

-- The read rules look memberships up by user, and todos by list.
create index members_user on "members" ("user_id", "list_id");
create index todos_list on "todos" ("list_id", "created_at");
