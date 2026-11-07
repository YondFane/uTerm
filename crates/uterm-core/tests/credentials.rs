#![cfg(any(target_os = "macos", windows))]

use uterm_core::credentials::access;

struct OwnedCredential {
    service: String,
    reference: String,
}
impl Drop for OwnedCredential {
    fn drop(&mut self) {
        let _ = access(&self.service, &self.reference, Some(None));
    }
}

#[test]
fn actual_system_credentials_distinguish_missing_and_preserve_neighboring_binary_items() {
    let service = format!("sh.uterm.desktop.qa.credentials.{}", uuid::Uuid::new_v4());
    let first = OwnedCredential {
        service: service.clone(),
        reference: uuid::Uuid::new_v4().to_string(),
    };
    let neighbor = OwnedCredential {
        service,
        reference: uuid::Uuid::new_v4().to_string(),
    };
    assert_eq!(
        access(&first.service, &first.reference, None).unwrap(),
        None
    );
    let original = vec![0, 255, 1, 128, 42];
    access(
        &first.service,
        &first.reference,
        Some(Some(original.clone())),
    )
    .unwrap();
    access(
        &neighbor.service,
        &neighbor.reference,
        Some(Some(vec![128, 0, 255])),
    )
    .unwrap();
    assert_eq!(
        access(&first.service, &first.reference, None).unwrap(),
        Some(original)
    );
    let replacement = vec![255, 0, 127, 2];
    access(
        &first.service,
        &first.reference,
        Some(Some(replacement.clone())),
    )
    .unwrap();
    assert_eq!(
        access(&first.service, &first.reference, None).unwrap(),
        Some(replacement)
    );
    access(&first.service, &first.reference, Some(None)).unwrap();
    assert_eq!(
        access(&first.service, &first.reference, None).unwrap(),
        None
    );
    assert_eq!(
        access(&neighbor.service, &neighbor.reference, None).unwrap(),
        Some(vec![128, 0, 255])
    );
    access(&first.service, &first.reference, Some(None)).unwrap();
    access(&neighbor.service, &neighbor.reference, Some(None)).unwrap();
    assert_eq!(
        access(&neighbor.service, &neighbor.reference, None).unwrap(),
        None
    );
}
