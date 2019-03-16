CREATE TABLE token (
  token_hash VARCHAR(64) NOT NULL,
  client_id VARCHAR(16) NOT NULL,
  username VARCHAR(16) NOT NULL,
  expiration INT(64) NOT NULL,
  PRIMARY KEY (`token_hash`),
  KEY client_id (client_id),
  KEY username (username),
  KEY expiration (expiration)
);

CREATE TABLE metadata (
  client_id VARCHAR(16) NOT NULL,
  username VARCHAR(16) NOT NULL,
  metadata LONGBLOB NOT NULL,
  PRIMARY KEY (`client_id`,`username`),
  KEY client_id (client_id),
  KEY username (username)
);
