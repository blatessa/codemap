CREATE TABLE users (id bigserial PRIMARY KEY, active boolean);
CREATE TABLE feeds (id bigserial PRIMARY KEY, title text);
CREATE TABLE entries (id bigserial PRIMARY KEY, feed_id bigint, user_id bigint, title text);
CREATE TABLE cache (k text PRIMARY KEY, v text);
