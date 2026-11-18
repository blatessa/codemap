CREATE TABLE account (
    id    bigserial PRIMARY KEY,
    email text NOT NULL UNIQUE
);
