use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ActivityEvent {
    pub id: String,
    pub sequence: u64,
    pub kind: String,
    pub source: String,
}

#[derive(Default)]
pub(crate) struct TerminalNotifications {
    state: u8,
    bytes: Vec<u8>,
}

impl TerminalNotifications {
    pub fn feed(&mut self, data: &[u8]) -> bool {
        let mut notice = false;
        for &byte in data {
            match (self.state, byte) {
                (0, 7) => notice = true,
                (0, 27) => self.state = 1,
                (1, b']') => {
                    self.bytes.clear();
                    self.state = 2;
                }
                (1, b'P' | b'_' | b'^' | b'X') => self.state = 4,
                (1, _) => self.state = 0,
                (2, 7) | (3, b'\\') => {
                    notice |= self.notification();
                    self.bytes.clear();
                    self.state = 0;
                }
                (2, 27) => self.state = 3,
                (2, 24 | 26) => {
                    self.bytes.clear();
                    self.state = 0;
                }
                (2, _) if self.bytes.len() < 16_384 => self.bytes.push(byte),
                (2, _) => {
                    // Discard an oversized sequence through its terminator, including embedded BEL.
                    // 丢弃过长序列直至终止符，包括其中的 BEL。
                    self.bytes.clear();
                    self.state = 4;
                }
                (3, _) => {
                    self.bytes.clear();
                    self.state = 0;
                }
                (4, 27) => self.state = 5,
                (4, 7) => self.state = 0,
                (5, b'\\') => self.state = 0,
                (5, _) => self.state = 4,
                _ => {}
            }
        }
        notice
    }

    fn notification(&self) -> bool {
        let Ok(text) = std::str::from_utf8(&self.bytes) else {
            return false;
        };
        if let Some(body) = text.strip_prefix("9;") {
            // OSC 9 also carries progress and directory controls; those are not notifications.
            // OSC 9 也携带进度及目录控制信息，这些并非通知。
            return !body.is_empty()
                && body
                    .split_once(';')
                    .is_none_or(|(command, _)| command.parse::<u32>().is_err());
        }
        text.strip_prefix("777;notify;")
            .is_some_and(|body| !body.is_empty())
            || text.strip_prefix("99;").is_some_and(|body| {
                body.split_once(';').is_some_and(|(metadata, payload)| {
                    !payload.is_empty()
                        && !metadata
                            .split(':')
                            .any(|part| matches!(part, "p=?" | "p=alive" | "p=close" | "d=0"))
                })
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notifications_survive_every_byte_boundary_without_interpreting_other_controls() {
        for sequence in [
            "\x07",
            "\x1b]9;42\x07",
            "\x1b]9;任务已结束\x07",
            "\x1b]777;notify;Agent;Ready\x1b\\",
            "\x1b]99;i=test;Ready\x1b\\",
        ] {
            for split in 0..=sequence.len() {
                let mut parser = TerminalNotifications::default();
                let first = parser.feed(&sequence.as_bytes()[..split]);
                let second = parser.feed(&sequence.as_bytes()[split..]);
                assert!(first || second, "split {split} of {sequence:?}");
            }
        }
        for sequence in [
            "\x1b]0;title\x07",
            "\x1b]9;4;1;80\x07",
            "\x1b]9;9;C:/work\x07",
            "\x1b]52;c;secret\x07",
            "\x1b]99;p=?;query\x07",
            "\x1b]99;d=0;part\x07",
            "\x1bPignored\x07",
            "ordinary output",
        ] {
            assert!(
                !TerminalNotifications::default().feed(sequence.as_bytes()),
                "{sequence:?}"
            );
        }
        let mut parser = TerminalNotifications::default();
        assert!(!parser.feed(&[b"\x1b]9;".as_slice(), &vec![b'x'; 20_000], b"\x07"].concat()));
        assert!(parser.feed(b"\x07"));
    }
}
