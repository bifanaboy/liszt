-- Preserve only resolver-verified multipart evidence. Existing links have no
-- part number; their order is not evidence of a multipart release.
ALTER TABLE scene_links ADD COLUMN part INTEGER CHECK (part IS NULL OR part > 0);
