-- Bed seed for PASTE: a site user that owns text uploads, slug URLs on.
INSERT INTO `users` (`id`, `oauth_uid`, `username`, `email_id`, `full_name`, `platform`, `password`, `verified`, `picture`, `ip`, `username_locked`, `date`)
VALUES (1, NULL, 'irc', 'irc@testnet.invalid', 'IRC uploads', 'Direct', '', '1', 'NONE', '127.0.0.1', 1, NOW());
