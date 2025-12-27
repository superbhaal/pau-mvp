-- Ajoute une colonne de préférence de langue pour les utilisateurs existants
ALTER TABLE users
ADD COLUMN IF NOT EXISTS language TEXT;
