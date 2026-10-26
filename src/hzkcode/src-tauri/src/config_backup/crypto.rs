use base64::{engine::general_purpose::STANDARD, Engine};
use ring::{aead, pbkdf2, rand::{SecureRandom, SystemRandom}};
use serde::{Deserialize, Serialize};
use std::num::NonZeroU32;

pub(super) const MAX_ARCHIVE: usize = 24 * 1024 * 1024;
pub(super) const MAX_PAYLOAD: usize = 16 * 1024 * 1024;
const FORMAT: &str = "hzkcode-config-backup";
const ITERATIONS: u32 = 600_000;
const AAD: &[u8] = b"hzkcode-config-backup:1:PBKDF2-SHA256:600000:AES-256-GCM";

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Envelope {
    format: String,
    version: u32,
    cipher: String,
    kdf: String,
    iterations: u32,
    salt: String,
    nonce: String,
    ciphertext: String,
}

pub(super) struct BackupKey {
    key: aead::LessSafeKey,
    salt: [u8; 16],
}

impl BackupKey {
    pub(super) fn new(password: &str) -> Result<Self, String> {
        let mut salt = [0; 16];
        SystemRandom::new().fill(&mut salt).map_err(|_| "backup_crypto")?;
        Self::derive(password, salt)
    }

    fn derive(password: &str, salt: [u8; 16]) -> Result<Self, String> {
        if password.chars().count() < 8 || password.len() > 4096 {
            return Err("password_invalid".into());
        }
        let mut bytes = [0; 32];
        pbkdf2::derive(pbkdf2::PBKDF2_HMAC_SHA256, NonZeroU32::new(ITERATIONS).unwrap(),
            &salt, password.as_bytes(), &mut bytes);
        let key = aead::UnboundKey::new(&aead::AES_256_GCM, &bytes).map_err(|_| "backup_crypto")?;
        bytes.fill(0);
        Ok(Self { key: aead::LessSafeKey::new(key), salt })
    }

    pub(super) fn seal(&self, payload: &[u8]) -> Result<Vec<u8>, String> {
        if payload.len() > MAX_PAYLOAD { return Err("backup_too_large".into()); }
        let mut nonce = [0; 12];
        SystemRandom::new().fill(&mut nonce).map_err(|_| "backup_crypto")?;
        let mut ciphertext = payload.to_vec();
        self.key.seal_in_place_append_tag(aead::Nonce::assume_unique_for_key(nonce),
            aead::Aad::from(AAD), &mut ciphertext).map_err(|_| "backup_crypto")?;
        serde_json::to_vec(&Envelope {
            format: FORMAT.into(), version: 1, cipher: "AES-256-GCM".into(),
            kdf: "PBKDF2-SHA256".into(), iterations: ITERATIONS,
            salt: STANDARD.encode(self.salt), nonce: STANDARD.encode(nonce),
            ciphertext: STANDARD.encode(ciphertext),
        }).map_err(|_| "backup_invalid".into())
    }
}

pub(super) fn open(bytes: &[u8], password: &str) -> Result<(Vec<u8>, BackupKey), String> {
    if bytes.len() > MAX_ARCHIVE { return Err("backup_too_large".into()); }
    let envelope: Envelope = serde_json::from_slice(bytes).map_err(|_| "backup_invalid")?;
    if envelope.format != FORMAT { return Err("backup_invalid".into()); }
    if envelope.version != 1 || envelope.cipher != "AES-256-GCM"
        || envelope.kdf != "PBKDF2-SHA256" || envelope.iterations != ITERATIONS {
        return Err("backup_version".into());
    }
    let salt: [u8; 16] = STANDARD.decode(&envelope.salt).map_err(|_| "backup_invalid")?
        .try_into().map_err(|_| "backup_invalid")?;
    let nonce: [u8; 12] = STANDARD.decode(&envelope.nonce).map_err(|_| "backup_invalid")?
        .try_into().map_err(|_| "backup_invalid")?;
    let mut ciphertext = STANDARD.decode(&envelope.ciphertext).map_err(|_| "backup_invalid")?;
    if ciphertext.len() > MAX_PAYLOAD + 16 { return Err("backup_too_large".into()); }
    let key = BackupKey::derive(password, salt)?;
    let plaintext = key.key.open_in_place(aead::Nonce::assume_unique_for_key(nonce),
        aead::Aad::from(AAD), &mut ciphertext).map_err(|_| "backup_decrypt_failed")?.to_vec();
    Ok((plaintext, key))
}
