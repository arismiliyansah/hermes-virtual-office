-- Canonical Hermes board statuses.
-- A fresh board may have no card in a column yet, but transitions to these
-- columns must still reach Hermes instead of becoming local office labels.
INSERT OR IGNORE INTO task_statuses (status) VALUES ('todo');
INSERT OR IGNORE INTO task_statuses (status) VALUES ('doing');
INSERT OR IGNORE INTO task_statuses (status) VALUES ('review');
INSERT OR IGNORE INTO task_statuses (status) VALUES ('done');
