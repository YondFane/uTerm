use std::io::{self, BufRead};
use uterm_core::{
    store::{Document, Import, Snapshot},
    Core, CoreError, Event, Request, Response,
};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    if args.next().as_deref() == Some("--schema") {
        let schemas = serde_json::json!({
            "CoreError":schemars::schema_for!(CoreError),
            "Request":schemars::schema_for!(Request),
            "Response":schemars::schema_for!(Response),
            "Event":schemars::schema_for!(Event),
            "Document":schemars::schema_for!(Document),
            "Import":schemars::schema_for!(Import),
            "Snapshot":schemars::schema_for!(Snapshot)
        });
        println!("{}", serde_json::to_string(&schemas)?);
        return Ok(());
    }
    let root = args
        .next()
        .ok_or("Usage: uterm-core-contract --schema | --serve ROOT")?;
    let core = Core::open(root.into())?;
    for line in io::stdin().lock().lines() {
        println!(
            "{}",
            serde_json::to_string(&core.execute(line?.as_bytes()))?
        );
    }
    Ok(())
}
