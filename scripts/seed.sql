-- Local development seed.
-- Password for the seeded user: hermes-dev
-- Regenerate the hash with:
--   node scripts/hash-password.mjs hermes-dev

INSERT INTO users (id, email, password_hash)
VALUES (
  'user-hermes',
  'hermes@hermes.local',
  'pbkdf2$100000$Z8KAEVrAJZH-F3_Ohb8m0A$Ny41DkuDd8tZUJwoKwYfqZIFDPzi9JiPhD7yj8664uU'
);
