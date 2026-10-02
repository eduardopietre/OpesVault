# sqlcipher3 ships no type information; its DB-API mirrors the stdlib sqlite3 module.
from sqlite3 import *  # noqa: F403
from sqlite3 import Connection as Connection
from sqlite3 import DatabaseError as DatabaseError
from sqlite3 import Error as Error
from sqlite3 import connect as connect

sqlite_version: str
