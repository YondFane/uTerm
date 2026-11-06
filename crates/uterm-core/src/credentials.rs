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
            // Absence is a normal lookup result; preserve actual access errors separately.
            // 凭据缺失属于正常查询结果，与实际访问错误分别保留。
            None => match get_generic_password(service, reference) {
                Ok(bytes) => Ok(Some(bytes)),
                Err(error) if error.code() == -25300 => Ok(None),
                Err(error) => Err(error.into()),
            },
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
                        let error = windows_sys::Win32::Foundation::GetLastError();
                        if error == windows_sys::Win32::Foundation::ERROR_NOT_FOUND {
                            return Ok(None);
                        }
                        return Err(std::io::Error::from_raw_os_error(error as i32).into());
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

// Clients select an isolated service name; workspace export never reads this adapter.
// 客户端选择隔离服务名；工作区导出不读取此适配器。
pub trait Credentials: Send + Sync {
    fn access(&self, reference: &str, value: Option<Option<Vec<u8>>>) -> Result<Option<Vec<u8>>>;
}

pub struct SystemCredentials {
    service: String,
}
impl SystemCredentials {
    pub fn new(service: String) -> Result<Self> {
        if service.is_empty() || service.len() > 512 || service.contains('\0') {
            anyhow::bail!("SSH_CREDENTIAL_FAILED");
        }
        Ok(Self { service })
    }
}
impl Credentials for SystemCredentials {
    fn access(&self, reference: &str, value: Option<Option<Vec<u8>>>) -> Result<Option<Vec<u8>>> {
        let reading = value.is_none();
        match access(&self.service, reference, value) {
            Err(error) if reading && missing(&error) => Ok(None),
            result => result,
        }
    }
}

fn missing(error: &anyhow::Error) -> bool {
    #[cfg(target_os = "macos")]
    return error
        .downcast_ref::<security_framework::base::Error>()
        .is_some_and(|error| error.code() == -25300);
    #[cfg(windows)]
    return error.downcast_ref::<std::io::Error>().is_some_and(|error| {
        error.raw_os_error() == Some(windows_sys::Win32::Foundation::ERROR_NOT_FOUND as i32)
    });
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = error;
        false
    }
}
