-- Create the global settings table
CREATE TABLE IF NOT EXISTS system_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    description TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Insert default Abandoned Cart timers (if they don't exist yet)
INSERT OR IGNORE INTO system_settings (key, value, description) 
VALUES ('abandoned_cart_first_delay_hours', '1', 'Hours to wait before sending the first abandoned cart reminder.');

INSERT OR IGNORE INTO system_settings (key, value, description) 
VALUES ('abandoned_cart_second_delay_hours', '24', 'Hours to wait before sending the second abandoned cart reminder.');
