-- Lab headroom for SYSTEM + UNDOTBS1 (explicit paths for Free container).
ALTER DATABASE DATAFILE '/opt/oracle/oradata/FREE/system01.dbf' RESIZE 800M;
ALTER DATABASE DATAFILE '/opt/oracle/oradata/FREE/system01.dbf' AUTOEXTEND ON NEXT 50M MAXSIZE UNLIMITED;
ALTER DATABASE DATAFILE '/opt/oracle/oradata/FREE/undotbs01.dbf' RESIZE 600M;
ALTER DATABASE DATAFILE '/opt/oracle/oradata/FREE/undotbs01.dbf' AUTOEXTEND ON NEXT 50M MAXSIZE UNLIMITED;
EXIT;
