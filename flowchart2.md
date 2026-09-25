flowchart TD
    subgraph SETUP["Step 1: Setup"]
        A["User uploads the binder<br/>(P&ID drawings)<br/>and the rulebooks<br/>(legends, symbols, codes)"] --> B["System creates a new<br/>'agent' for this binder"]
    end

    subgraph READ["Step 2: System reads the documents"]
        B --> C["Builds the equipment list<br/>(pumps, vessels, tanks, etc.)<br/>and notes any pages<br/>it could not read"]
        C --> D["AI reads every page<br/>and writes a short summary"]
        D --> E{"Was the AI<br/>available?"}
        E -->|"Yes"| F["Summary saved"]
        E -->|"No"| G["Page text saved as-is<br/>(still searchable)"]
        F --> H["All pages are made searchable"]
        G --> H
        H --> I["Agent marked as READY"]
    end

    D -.->|"Progress shown to user:<br/>'Reading sheet 12 of 140'"| P["User sees progress"]
    D -.->|"If reading stops"| R["User clicks<br/>'Continue reading'<br/>(finished pages are kept)"]
    R -.-> D

    subgraph ASK["Step 3: Ask questions"]
        I --> J["User asks a question<br/>e.g. 'How many pumps are there?'<br/>or a follow-up like<br/>'What is its design pressure?'"]
        J --> K["System finds the matching pages,<br/>using the recent conversation<br/>to understand follow-ups"]
        K --> L["AI writes an answer using<br/>only those pages and<br/>the equipment list,<br/>noting any unreadable pages"]
        L --> M{"AI service<br/>answered?"}
        M -->|"Yes"| N["User sees the answer<br/>with page references"]
        M -->|"No, within seconds"| X["User sees:<br/>'Please try again in a minute'"]
        N --> O["User can click a reference<br/>to view the original drawing"]
    end