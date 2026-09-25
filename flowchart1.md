flowchart TD
    %% ---------- Start ----------
    U["User uploads the binder<br/>and the rulebooks"]
    B["User clicks<br/>Create agent"]

    %% ---------- Step 1: set up the agent ----------
    S1["Create a folder for this agent<br/>e.g. agents/binder1_2026-09-24/"]
    S1b["Copy the binder and rulebooks<br/>into the input/ folder"]
    S1c["Create agent.db<br/>and write status = processing"]

    %% ---------- Step 2: read the rulebooks ----------
    S2["Read each legend sheet:<br/>abbreviations, fluid codes,<br/>instrument letter codes"]
    S2b["Save a picture of<br/>each legend sheet"]

    %% ---------- Step 3: go through the binder page by page ----------
    S3["Take the next binder page"]
    D3{"Does the page<br/>have parseable text?"}
    OCR["Read it with OCR"]
    S3b["Read drawing number, title<br/>and unit from the title block"]
    S3c["Save an image of the page"]

    %% ---------- Step 4: find equipment and instruments ----------
    S4["Find the equipment:<br/>big titles like 0751-V-101,<br/>the name and the data block"]
    S4b["Find the instruments:<br/>tags like LT-2001"]

    %% ---------- Step 5: follow the pipes ----------
    S5["Follow the pipes on this page<br/>from equipment to equipment,<br/>through valves, using arrows<br/>for direction"]
    D5{"More pages?"}
    S5b["Join the pages together<br/>by matching connector numbers<br/>e.g. 989 on page 1 and page 2"]

    %% ---------- Step 6: keep page text (if A+B) ----------
    S6["Save the text of every page so other questions can be answered"]

    %% ---------- Step 7: finish ----------
    D7{"Did anything fail?"}
    F["Status = failed with the reason<br/>User can retry"]
    R["Status = ready with totals:<br/>pages, equipment, connections"]
    Q["User sees the summary<br/>and can ask questions"]

    %% ---------- The agent's folder ----------
    subgraph FOLDER["Agent folder "]
        IN[/"input/<br/>copies of binder and rulebooks"/]
        PG[/"pages/<br/>one image per binder page"/]
        RB[/"rulebook/<br/>one image per legend sheet"/]
        subgraph DB["agent.db"]
            T0[("agent info<br/>name, date, status")]
            T1[("rulebook_entries")]
            T2[("pages")]
            T3[("equipment<br/>equipment_data")]
            T4[("instruments")]
            T5[("connections")]
            T6[("page_text<br/>+ search index")]
        end
    end

    %% ---------- Main flow ----------
    U --> B --> S1 --> S1b --> S1c --> S2 --> S2b --> S3 --> D3
    D3 -->|no| OCR --> S3b
    D3 -->|yes| S3b
    S3b --> S3c --> S4 --> S4b --> S5 --> D5
    D5 -->|yes| S3
    D5 -->|no| S5b --> S6 --> D7
    D7 -->|yes| F
    D7 -->|no| R --> Q

    %% ---------- Where things get saved ----------
    S1b -.-> IN
    S1c -.-> T0
    S2 -.-> T1
    S2b -.-> RB
    S3b -.-> T2
    S3c -.-> PG
    S4 -.-> T3
    S4b -.-> T4
    S5 -.-> T5
    S5b -.-> T5
    S6 -.-> T6
    R -.-> T0
    F -.-> T0

    %% ---------- Colours ----------
    classDef step fill:#dbeafe,stroke:#3b82f6,color:#000
    classDef decision fill:#fef3c7,stroke:#d97706,color:#000
    classDef store fill:#dcfce7,stroke:#16a34a,color:#000
    classDef optional fill:#f3f4f6,stroke:#9ca3af,color:#000,stroke-dasharray: 5 5
    classDef bad fill:#fee2e2,stroke:#dc2626,color:#000

    class U,B,S1,S1b,S1c,S2,S2b,S3,OCR,S3b,S3c,S4,S4b,S5,S5b,R,Q step
    class D3,D5,D7 decision
    class IN,PG,RB,T0,T1,T2,T3,T4,T5 store
    class S6,T6 optional
    class F bad