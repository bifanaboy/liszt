CREATE TABLE hatchable_pilot_state (
  id SMALLINT PRIMARY KEY,
  counter INTEGER NOT NULL DEFAULT 0
);

INSERT INTO hatchable_pilot_state (id, counter) VALUES (1, 0);
