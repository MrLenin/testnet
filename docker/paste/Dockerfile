# PASTE (boxlabss/PASTE, MrLenin fork branch filehost) as the bed's FILEHOST
# upload host.  The tree is bind-mounted at /var/www/html; this image only
# supplies PHP, the extensions PASTE needs, and an entrypoint that writes
# config.php from the environment.
FROM php:8.3-apache
RUN apt-get update \
 && apt-get install -y --no-install-recommends libpng-dev libjpeg62-turbo-dev libfreetype6-dev libzip-dev openssl default-mysql-client \
 && docker-php-ext-configure gd --with-freetype --with-jpeg \
 && docker-php-ext-install -j"$(nproc)" pdo_mysql gd \
 && a2enmod rewrite headers \
 && rm -rf /var/lib/apt/lists/*
COPY entrypoint.sh /usr/local/bin/paste-entrypoint.sh
COPY gen-config.php /gen-config.php
RUN chmod +x /usr/local/bin/paste-entrypoint.sh \
 && printf 'post_max_size=64M\nupload_max_filesize=64M\nmemory_limit=256M\n' > /usr/local/etc/php/conf.d/filehost.ini \
 && sed -i 's/AllowOverride None/AllowOverride All/' /etc/apache2/apache2.conf
ENTRYPOINT ["/usr/local/bin/paste-entrypoint.sh"]
CMD ["apache2-foreground"]
