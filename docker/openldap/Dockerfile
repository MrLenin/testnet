# Custom openldap = osixia-based startcodex/openldap + X3's inetOrgAnonAccount schema baked
# into the bootstrap dir. Baked (NOT bind-mounted) on purpose: osixia's first-init
# chown/sed/rm's everything under bootstrap/, which corrupts and deletes a bind-mounted
# source file (observed: crash-loop + the host copy gets deleted). With the schema in the
# image layer, osixia processes its own file (schema-to-ldif.sh + ldapadd -Y EXTERNAL over
# ldapi) and a fresh copy is restored on every container start.
FROM startcodex/openldap:latest
COPY inetorganon.schema /container/service/slapd/assets/config/bootstrap/schema/inetorganon.schema
