-- Lab Always On (read-scale, CLUSTER_TYPE=NONE) between primary and secondary.
-- Primary: host network :1433 (IKS / datasync-mssql-test)
-- Secondary: buho-mssql-ha :14333 → container 1433 (mssql-ha)

-- ===== PRIMARY =====
USE master;
GO

IF NOT EXISTS (SELECT 1 FROM sys.symmetric_keys WHERE name = '##MS_DatabaseMasterKey##')
  CREATE MASTER KEY ENCRYPTION BY PASSWORD = 'Buho_Ag_MasterKey_1!';
GO

IF NOT EXISTS (SELECT 1 FROM sys.certificates WHERE name = 'buho_ag_cert')
  CREATE CERTIFICATE buho_ag_cert
    WITH SUBJECT = 'Búho AG endpoint';
GO

BACKUP CERTIFICATE buho_ag_cert
  TO FILE = '/var/opt/mssql/buho_ag_cert.cer'
  WITH PRIVATE KEY (
    FILE = '/var/opt/mssql/buho_ag_cert.key',
    ENCRYPTION BY PASSWORD = 'Buho_Ag_CertKey_1!'
  );
GO

IF NOT EXISTS (SELECT 1 FROM sys.endpoints WHERE name = 'Hadr_endpoint')
BEGIN
  CREATE ENDPOINT Hadr_endpoint
    STATE = STARTED
    AS TCP (LISTENER_PORT = 5022, LISTENER_IP = ALL)
    FOR DATABASE_MIRRORING (
      ROLE = ALL,
      AUTHENTICATION = CERTIFICATE buho_ag_cert,
      ENCRYPTION = REQUIRED ALGORITHM AES
    );
END
ELSE
  ALTER ENDPOINT Hadr_endpoint STATE = STARTED;
GO
