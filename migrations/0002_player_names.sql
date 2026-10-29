-- Player names for the public rankings. Older portfolios have no name until the player picks one.
ALTER TABLE portfolios ADD COLUMN name TEXT;
CREATE UNIQUE INDEX portfolios_by_name ON portfolios (lower(name)) WHERE name IS NOT NULL;
