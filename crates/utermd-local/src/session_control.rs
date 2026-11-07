use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};

pub const CAPABILITY: &str = "session-input-control-v1";
const LEASE_TTL: Duration = Duration::from_secs(30);
const LEGACY: &str = "legacy";

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct View {
    pub id: String,
    pub label: String,
    pub lease: Option<String>,
}
impl View {
    pub fn new(label: &str) -> Result<Self> {
        let value = Self {
            id: uuid::Uuid::new_v4().to_string(),
            label: label.into(),
            lease: None,
        };
        value.validate()?;
        Ok(value)
    }
    pub fn validate(&self) -> Result<()> {
        if uuid::Uuid::parse_str(&self.id).is_err()
            || self
                .lease
                .as_ref()
                .is_some_and(|value| uuid::Uuid::parse_str(value).is_err())
            || self.label.is_empty()
            || self.label.len() > 128
            || self.label.chars().any(char::is_control)
        {
            bail!("SESSION_CONTROL_INVALID");
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Status {
    pub owned: bool,
    pub owner: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Grant {
    pub status: Status,
    pub lease: Option<String>,
}
struct Lease {
    id: String,
    label: String,
    token: String,
    until: Instant,
}
#[derive(Default)]
pub(crate) struct Control {
    lease: Option<Lease>,
}
impl Control {
    pub fn revision(&self) -> Option<&str> {
        self.lease.as_ref().map(|value| value.token.as_str())
    }
    pub fn expire(&mut self, now: Instant) {
        if self.lease.as_ref().is_some_and(|value| value.until <= now) {
            self.lease = None;
        }
    }
    fn matches(&self, view: &View) -> bool {
        self.lease
            .as_ref()
            .is_some_and(|lease| lease.id == view.id && view.lease.as_deref() == Some(&lease.token))
    }
    fn replace(&mut self, id: String, label: String, now: Instant) {
        self.lease = Some(Lease {
            id,
            label,
            token: uuid::Uuid::new_v4().to_string(),
            until: now + LEASE_TTL,
        });
    }
    pub fn status(&mut self, view: &View, now: Instant) -> Status {
        self.expire(now);
        Status {
            owned: self.matches(view),
            owner: self.lease.as_ref().map(|value| value.label.clone()),
        }
    }
    pub fn claim(&mut self, view: &View, takeover: bool, now: Instant) -> Grant {
        self.expire(now);
        if self.matches(view) {
            self.lease.as_mut().unwrap().until = now + LEASE_TTL;
        } else if takeover || (self.lease.is_none() && view.lease.is_none()) {
            self.replace(view.id.clone(), view.label.clone(), now);
        } else {
            return Grant {
                status: self.status(view, now),
                lease: None,
            };
        }
        Grant {
            status: Status {
                owned: true,
                owner: Some(view.label.clone()),
            },
            lease: self.lease.as_ref().map(|value| value.token.clone()),
        }
    }
    pub fn authorize(&mut self, view: Option<&View>, now: Instant) -> Result<()> {
        self.expire(now);
        if let Some(view) = view {
            if !self.matches(view) {
                bail!("SESSION_CONTROL_REQUIRED");
            }
        } else {
            if self.lease.is_none() {
                self.replace(LEGACY.into(), "uTerm".into(), now);
            }
            if self.lease.as_ref().is_some_and(|value| value.id != LEGACY) {
                bail!("SESSION_CONTROL_REQUIRED");
            }
        }
        self.lease.as_mut().unwrap().until = now + LEASE_TTL;
        Ok(())
    }
    pub fn release(&mut self, view: &View, now: Instant) {
        self.expire(now);
        if self.matches(view) {
            self.lease = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn granted(control: &mut Control, view: &mut View, takeover: bool, now: Instant) -> bool {
        let result = control.claim(view, takeover, now);
        view.lease = result.lease;
        result.status.owned
    }
    #[test]
    fn takeover_revokes_old_input_resize_and_late_release_without_losing_the_new_owner() {
        let now = Instant::now();
        let mut control = Control::default();
        let mut first = View::new("First").unwrap();
        let mut second = View::new("Second").unwrap();
        assert!(granted(&mut control, &mut first, false, now));
        assert!(control.authorize(Some(&first), now).is_ok());
        assert!(!granted(&mut control, &mut second, false, now));
        assert!(control.authorize(Some(&second), now).is_err());
        assert!(granted(&mut control, &mut second, true, now));
        assert!(control.authorize(Some(&first), now).is_err());
        let revision = control.revision().unwrap().to_owned();
        control.release(&first, now);
        assert_eq!(control.revision(), Some(revision.as_str()));
        assert!(control.authorize(Some(&second), now).is_ok());
        control.release(&second, now);
        assert!(control.revision().is_none());
    }
    #[test]
    fn expired_lease_cannot_renew_or_write_until_a_fresh_explicit_claim() {
        let now = Instant::now();
        let mut control = Control::default();
        let mut first = View::new("First").unwrap();
        assert!(granted(&mut control, &mut first, false, now));
        let expired = now + LEASE_TTL;
        assert!(control.authorize(Some(&first), expired).is_err());
        assert!(!control.claim(&first, false, expired).status.owned);
        assert!(granted(&mut control, &mut first, true, expired));
        let old = first.clone();
        control.release(&first, expired);
        assert!(granted(&mut control, &mut first, true, expired));
        assert!(control.authorize(Some(&old), expired).is_err());
    }
    #[test]
    fn input_and_heartbeat_renew_without_changing_the_lease_or_allowing_passive_takeover() {
        let now = Instant::now();
        let mut control = Control::default();
        let mut first = View::new("First").unwrap();
        let second = View::new("Second").unwrap();
        assert!(granted(&mut control, &mut first, false, now));
        let revision = first.lease.clone();
        assert!(control
            .authorize(Some(&first), now + Duration::from_secs(20))
            .is_ok());
        assert!(granted(
            &mut control,
            &mut first,
            false,
            now + Duration::from_secs(40)
        ));
        assert_eq!(first.lease, revision);
        assert!(
            !control
                .claim(&second, false, now + Duration::from_secs(41))
                .status
                .owned
        );
        assert!(control
            .authorize(Some(&first), now + Duration::from_secs(60))
            .is_ok());
    }
    #[test]
    fn legacy_writes_resume_after_release_but_cannot_override_a_managed_owner() {
        let now = Instant::now();
        let mut control = Control::default();
        assert!(control.authorize(None, now).is_ok());
        let mut view = View::new("Native").unwrap();
        assert!(!granted(&mut control, &mut view, false, now));
        assert!(granted(&mut control, &mut view, true, now));
        assert!(control.authorize(None, now).is_err());
        control.release(&view, now);
        assert!(control.authorize(None, now).is_ok());
    }
    #[test]
    fn owner_identifiers_tokens_and_labels_are_bounded_before_mutation() {
        let mut view = View::new("uTerm").unwrap();
        view.id = "legacy".into();
        assert!(view.validate().is_err());
        assert!(View::new(&"x".repeat(129)).is_err());
        assert!(View::new("line\nbreak").is_err());
        let mut view = View::new("原生客户端").unwrap();
        view.lease = Some("stale".into());
        assert!(view.validate().is_err());
    }
}
