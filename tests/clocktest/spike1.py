#!/usr/bin/env python3
"""Spike 1: prove /CRDT clockstep moves CurrentTime live (TIME probe), that a
backward step restores cleanly, that nef4's static +30 boot skew is visible,
and that the mesh stays converged with zero restarts afterward."""
import sys
import time

from ircdrv import open_opers, close_all, mesh_digests, report_digests, restart_counts

opers = open_opers(['nef3', 'nef4', 'nef6'])
try:
    n4, n6 = opers['nef4'], opers['nef6']

    # nef4 static boot skew: TStime should sit ~+30 off the host clock
    h4, t4 = time.time(), n4.time_ts()
    static_skew = t4 - h4
    print('nef4 static skew vs host: %+0.1f s (expect ~+30)' % static_skew)
    ok_static = 28.0 <= static_skew <= 33.0

    h0, t0 = time.time(), n6.time_ts()
    base = t0 - h0
    print('nef6 baseline skew vs host: %+0.1f s (expect ~0)' % base)

    print('clockstep +7 ->', n6.clockstep(+7))
    time.sleep(1.2)
    h1, t1 = time.time(), n6.time_ts()
    d1 = (t1 - h1) - base
    print('after +7: host-relative shift %+0.1f s' % d1)
    ok_fwd = 5.5 <= d1 <= 8.5

    print('clockstep -7 ->', n6.clockstep(-7))
    time.sleep(1.2)
    h2, t2 = time.time(), n6.time_ts()
    d2 = (t2 - h2) - base
    print('after -7: host-relative shift %+0.1f s (expect ~0)' % d2)
    ok_back = -1.5 <= d2 <= 1.5

    print('\nmesh digests after steps:')
    conv = report_digests(mesh_digests(opers))
    rc = restart_counts()
    print('restart counts:', rc)
    ok_rc = all(v == '0' for v in rc.values())

    verdict = ok_static and ok_fwd and ok_back and conv and ok_rc
    print('\nSPIKE1 %s  (static+30=%s fwd=%s back=%s converged=%s no_restarts=%s)'
          % ('PASS' if verdict else 'FAIL',
             ok_static, ok_fwd, ok_back, conv, ok_rc))
    sys.exit(0 if verdict else 1)
finally:
    close_all(opers)
