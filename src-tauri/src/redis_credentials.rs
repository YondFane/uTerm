use anyhow::Result;

pub fn validate_reference(reference: &str) -> Result<()> {
    uuid::Uuid::parse_str(reference)?;
    Ok(())
}

pub fn access(
    service: &str,
    reference: &str,
    value: Option<Option<Vec<u8>>>,
) -> Result<Option<Vec<u8>>> {
    validate_reference(reference)?;
    #[cfg(target_os = "macos")]
    {
        use security_framework::passwords::*;
        return match value {
            Some(Some(bytes)) => {
                set_generic_password(service, reference, &bytes)?;
                Ok(None)
            }
            Some(None) => match delete_generic_password(service, reference) {
                Ok(()) => Ok(None),
                Err(error) if error.code() == -25300 => Ok(None),
                Err(error) => Err(error.into()),
            },
            None => Ok(Some(get_generic_password(service, reference)?)),
        };
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::Security::Credentials::*;
        let name: Vec<u16> = format!("{service}/{reference}")
            .encode_utf16()
            .chain(Some(0))
            .collect();
        unsafe {
            return match value {
                Some(Some(mut bytes)) => {
                    if bytes.len() > CRED_MAX_CREDENTIAL_BLOB_SIZE as usize {
                        anyhow::bail!("REDIS_CREDENTIAL_SIZE");
                    }
                    let mut credential: CREDENTIALW = std::mem::zeroed();
                    credential.Type = CRED_TYPE_GENERIC;
                    credential.TargetName = name.as_ptr().cast_mut();
                    credential.CredentialBlob = bytes.as_mut_ptr();
                    credential.CredentialBlobSize = bytes.len() as u32;
                    credential.Persist = CRED_PERSIST_LOCAL_MACHINE;
                    if CredWriteW(&credential, 0) == 0 {
                        return Err(std::io::Error::last_os_error().into());
                    }
                    Ok(None)
                }
                Some(None) => {
                    if CredDeleteW(name.as_ptr(), CRED_TYPE_GENERIC, 0) == 0
                        && windows_sys::Win32::Foundation::GetLastError()
                            != windows_sys::Win32::Foundation::ERROR_NOT_FOUND
                    {
                        return Err(std::io::Error::last_os_error().into());
                    }
                    Ok(None)
                }
                None => {
                    let mut credential = std::ptr::null_mut();
                    if CredReadW(name.as_ptr(), CRED_TYPE_GENERIC, 0, &mut credential) == 0 {
                        return Err(std::io::Error::last_os_error().into());
                    }
                    let bytes = if (*credential).CredentialBlobSize == 0 {
                        Vec::new()
                    } else {
                        std::slice::from_raw_parts(
                            (*credential).CredentialBlob,
                            (*credential).CredentialBlobSize as usize,
                        )
                        .to_vec()
                    };
                    CredFree(credential.cast());
                    Ok(Some(bytes))
                }
            };
        }
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = (service, reference, value);
        anyhow::bail!("REDIS_CREDENTIAL_UNAVAILABLE")
    }
}
