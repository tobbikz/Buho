-- Monitor user for Oracle — least privilege (Búho read-only collectors)
--
-- Run as a DBA (SYS / SYSTEM) once per PDB/CDB you monitor:
--   sqlplus sys/xxx@host:1521/ORCLPDB as sysdba @monitor-user-oracle.sql
--
-- Change the password before running. Búho never writes to the monitored DB.

DEFINE buho_password = 'CHANGE-THIS-PASSWORD'

CREATE USER buho_monitor IDENTIFIED BY "&buho_password"
  DEFAULT TABLESPACE USERS
  TEMPORARY TABLESPACE TEMP
  QUOTA 0 ON USERS;

ALTER USER buho_monitor ACCOUNT UNLOCK;
ALTER USER buho_monitor PROFILE DEFAULT;

-- Session + dictionary visibility used by collectors / inventory / RPO.
GRANT CREATE SESSION TO buho_monitor;
GRANT SELECT_CATALOG_ROLE TO buho_monitor;

-- Explicit V$ / DBA views when SELECT_CATALOG_ROLE is too broad for policy.
-- Safe to re-run; ignore ORA-00942 if a view is missing on your edition.
BEGIN
  FOR r IN (
    SELECT column_value AS obj FROM TABLE(sys.odcivarchar2list(
      'V$INSTANCE',
      'V$DATABASE',
      'V$SESSION',
      'V$SQL',
      'V$SQLAREA',
      'V$SYSSTAT',
      'V$SYSTEM_EVENT',
      'V$OSSTAT',
      'V$PARAMETER',
      'V$TABLESPACE',
      'V$DATAFILE',
      'V$LOG',
      'V$LOGFILE',
      'V$ARCHIVED_LOG',
      'V$BACKUP_SET',
      'V$RMAN_BACKUP_JOB_DETAILS',
      'DBA_USERS',
      'DBA_ROLE_PRIVS',
      'DBA_SYS_PRIVS',
      'DBA_TAB_PRIVS',
      'DBA_DATA_FILES',
      'DBA_FREE_SPACE',
      'DBA_TABLESPACES',
      'DBA_OBJECTS',
      'DBA_INDEXES',
      'DBA_SEGMENTS'
    ))
  ) LOOP
    BEGIN
      EXECUTE IMMEDIATE 'GRANT SELECT ON ' || r.obj || ' TO buho_monitor';
    EXCEPTION
      WHEN OTHERS THEN
        IF SQLCODE NOT IN (-942, -1031) THEN RAISE; END IF;
    END;
  END LOOP;
END;
/
