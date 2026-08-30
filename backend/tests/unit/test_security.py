import pytest

from core.security import hash_password, verify_password


pytestmark = pytest.mark.unit


def test_hash_password_does_not_return_plaintext():
    plaintext = "correct horse battery staple"

    assert hash_password(plaintext) != plaintext


def test_verify_password_accepts_correct_password():
    plaintext = "correct horse battery staple"
    stored_hash = hash_password(plaintext)

    assert verify_password(plaintext, stored_hash) is True


def test_verify_password_rejects_incorrect_password():
    stored_hash = hash_password("correct horse battery staple")

    assert verify_password("incorrect password", stored_hash) is False


def test_hash_password_uses_distinct_random_salts():
    plaintext = "correct horse battery staple"

    assert hash_password(plaintext) != hash_password(plaintext)


@pytest.mark.parametrize("stored_hash", ["", "not-a-password-hash", "$argon2id$invalid"])
def test_verify_password_rejects_malformed_hash(stored_hash):
    assert verify_password("correct horse battery staple", stored_hash) is False
