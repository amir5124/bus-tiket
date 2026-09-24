CREATE TABLE IF NOT EXISTS bus_payments (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  booking_id BIGINT NOT NULL,
  payment_reff VARCHAR(80) NOT NULL UNIQUE,
  payment_method VARCHAR(50) NOT NULL,
  va_number VARCHAR(100) NULL,
  qris_url TEXT NULL,
  admin_fee DECIMAL(15,2) NOT NULL DEFAULT 0,
  amount DECIMAL(15,2) NOT NULL,
  payment_status VARCHAR(30) NOT NULL DEFAULT 'PENDING',
  expired_date DATETIME NULL,
  payment_date DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_bus_payments_booking (booking_id),
  INDEX idx_bus_payments_status (payment_status)
);
