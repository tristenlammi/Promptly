import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Plus } from "lucide-react";

import { Button } from "@/components/shared/Button";
import { NewStudyWizard } from "@/components/study/NewStudyWizard";
import { StudyProjectList } from "@/components/study/StudyProjectList";
import { TopNav } from "@/components/layout/TopNav";
import { studyApi } from "@/api/study";
import { useStudyProjectsQuery } from "@/hooks/useStudy";

export function StudyPage() {
  const navigate = useNavigate();
  const [wizardOpen, setWizardOpen] = useState(false);
  const { data: projects, isLoading } = useStudyProjectsQuery();

  const handleOpenProject = async (projectId: string) => {
    // Projects may have multiple sessions; pick the most recent one, or
    // create a new session on the fly if they somehow have none.
    try {
      const detail = await studyApi.getProject(projectId);
      const sessions = [...detail.sessions].sort((a, b) =>
        b.updated_at.localeCompare(a.updated_at)
      );
      if (sessions.length === 0) {
        const s = await studyApi.createSession(projectId);
        navigate(`/study/sessions/${s.id}`);
      } else {
        navigate(`/study/sessions/${sessions[0].id}`);
      }
    } catch {
      // Silently fall back — the next click will try again.
    }
  };

  return (
    <>
      <TopNav
        title="Study"
        subtitle="AI-powered study sessions with an interactive whiteboard"
        actions={
          <Button
            variant="primary"
            leftIcon={<Plus className="h-4 w-4" />}
            onClick={() => setWizardOpen(true)}
          >
            New study session
          </Button>
        }
      />
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-5xl px-6 py-6">
          {isLoading ? (
            <div className="text-sm text-[var(--text-muted)]">
              Loading study projects...
            </div>
          ) : (
            <StudyProjectList
              projects={projects ?? []}
              onOpen={handleOpenProject}
            />
          )}
        </div>
      </div>

      <NewStudyWizard open={wizardOpen} onClose={() => setWizardOpen(false)} />
    </>
  );
}
