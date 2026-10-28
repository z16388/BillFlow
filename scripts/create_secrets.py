"""Run on your own machine, then keep values in the private server .env."""
from cryptography.fernet import Fernet

print('CREDENTIAL_KEY=' + Fernet.generate_key().decode())
